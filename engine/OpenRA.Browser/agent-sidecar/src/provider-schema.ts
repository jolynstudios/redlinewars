// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const UnsupportedStrictSchemaKeywords = new Set([
	'$schema',
	'exclusiveMaximum',
	'exclusiveMinimum',
	'format',
	'maxItems',
	'maxLength',
	'maxProperties',
	'maximum',
	'minItems',
	'minLength',
	'minProperties',
	'minimum',
	'multipleOf',
	'pattern',
	'uniqueItems'
]);

export function providerSafeSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(providerSafeSchema);
	}

	if (value == null || typeof value !== 'object') {
		return value;
	}

	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (UnsupportedStrictSchemaKeywords.has(key)) {
			continue;
		}

		// Schema keywords apply to the current schema object; the `properties`
		// map holds field NAMES, so recurse into each value without filtering
		// the names themselves (a field could legitimately be called "pattern").
		if (key === 'properties' && entry != null && typeof entry === 'object' && !Array.isArray(entry)) {
			const props: Record<string, unknown> = {};
			for (const [name, propSchema] of Object.entries(entry as Record<string, unknown>)) {
				props[name] = providerSafeSchema(propSchema);
			}

			result.properties = props;
			continue;
		}

		// OpenAI strict structured output accepts nested anyOf but not oneOf.
		if (key === 'oneOf') {
			result.anyOf = providerSafeSchema(entry);
			continue;
		}

		// Gemini's schema dialect only accepts enum on string types, so
		// non-string literals keep their type but drop the value pin; Zod
		// re-validates the exact literal after generation.
		if (key === 'const') {
			if (typeof entry === 'string') {
				result.enum = [entry];
			}

			continue;
		}

		if (key === 'enum' && Array.isArray(entry) && !entry.every(option => typeof option === 'string')) {
			continue;
		}

		result[key] = providerSafeSchema(entry);
	}

	// OpenAI strict structured output requires every property to appear in
	// `required`. Zod-optional/defaulted fields (e.g. the commander memo) are
	// forgiven at validation time, but the provider schema demands them so
	// strict-mode providers never reject the dialect.
	if (result.type === 'object' && result.properties != null && typeof result.properties === 'object') {
		result.required = Object.keys(result.properties as Record<string, unknown>);
	}

	return result;
}

// Action types that stay legal on the guided/executor surface regardless of the
// control phase. acceptDoctrineDecision is the exact-choice escape hatch the host
// uses for a pendingDecision — phase narrowing must never strip it or the model
// loses the ability to answer a host-authored decision through structured output.
const PhaseAgnosticActionTypes = new Set(['acceptDoctrineDecision']);

// Read a provider-schema action variant's discriminating type literal. Handles
// both the z.toJSONSchema/AI-SDK shape ({ type: { const: 'move' } }) and an
// already-enum-normalised shape ({ type: { enum: ['move'] } }); returns
// undefined for anything it cannot classify so the caller can fail open.
function variantActionType(variant: unknown): string | undefined {
	if (variant == null || typeof variant !== 'object' || Array.isArray(variant)) {
		return undefined;
	}

	const properties = (variant as Record<string, unknown>).properties;
	if (properties == null || typeof properties !== 'object') {
		return undefined;
	}

	const typeSchema = (properties as Record<string, unknown>).type;
	if (typeSchema == null || typeof typeSchema !== 'object') {
		return undefined;
	}

	const record = typeSchema as Record<string, unknown>;
	if (typeof record.const === 'string') {
		return record.const;
	}

	if (Array.isArray(record.enum) && record.enum.length === 1 && typeof record.enum[0] === 'string') {
		return record.enum[0] as string;
	}

	return undefined;
}

// Intersect the provider-visible action union with the host-authored legal action
// types for the current control phase (guided/executor surface only). This is
// purely a provider hint: the sidecar's Zod batch schema remains the full
// authority, so a narrower provider surface only reduces strict-schema retries —
// it never rejects an action the host would accept. Fail-safe by construction:
// returns the schema UNCHANGED when legalActionTypes is absent/empty, when the
// actions union is not the expected inlined anyOf/oneOf of typed variants, when
// nothing would be removed, or when narrowing would leave no variant (never emit
// an empty union). The raw track passes no legalActionTypes, so its provider
// bytes stay byte-identical.
export function narrowActionSchema(schema: unknown, legalActionTypes?: readonly string[]): unknown {
	if (!Array.isArray(legalActionTypes) || legalActionTypes.length === 0) {
		return schema;
	}

	if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
		return schema;
	}

	const root = schema as Record<string, unknown>;
	const properties = root.properties;
	if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) {
		return schema;
	}

	const actions = (properties as Record<string, unknown>).actions;
	if (actions == null || typeof actions !== 'object' || Array.isArray(actions)) {
		return schema;
	}

	const items = (actions as Record<string, unknown>).items;
	if (items == null || typeof items !== 'object' || Array.isArray(items)) {
		return schema;
	}

	const itemsRecord = items as Record<string, unknown>;
	const unionKey = Array.isArray(itemsRecord.anyOf) ? 'anyOf' : Array.isArray(itemsRecord.oneOf) ? 'oneOf' : undefined;
	if (unionKey == null) {
		return schema;
	}

	const variants = itemsRecord[unionKey] as unknown[];
	const legal = new Set(legalActionTypes);
	const kept = variants.filter(variant => {
		const type = variantActionType(variant);
		// Fail open on a variant we cannot classify: keep it rather than risk
		// dropping something the model legitimately needs. Only variants whose
		// known type is not legal in this phase (and not phase-agnostic) drop.
		if (type == null) {
			return true;
		}

		return legal.has(type) || PhaseAgnosticActionTypes.has(type);
	});

	// Never narrow to nothing, and skip the rebuild when nothing was removed.
	if (kept.length === 0 || kept.length === variants.length) {
		return schema;
	}

	return {
		...root,
		properties: {
			...(properties as Record<string, unknown>),
			actions: {
				...(actions as Record<string, unknown>),
				items: { ...itemsRecord, [unionKey]: kept }
			}
		}
	};
}

export function makeProviderRequestCompatible(
	args: Record<string, any>, legalActionTypes?: readonly string[]): Record<string, any> {
	const responseFormat = args.response_format as Record<string, unknown> | undefined;
	const jsonSchema = responseFormat?.json_schema as Record<string, unknown> | undefined;
	if (responseFormat?.type !== 'json_schema' || jsonSchema?.schema == null) {
		return args;
	}

	return {
		...args,
		response_format: {
			...responseFormat,
			json_schema: {
				...jsonSchema,
				schema: providerSafeSchema(narrowActionSchema(jsonSchema.schema, legalActionTypes))
			}
		}
	};
}

// Fallback for providers that reject the json_schema response_format dialect
// outright: request plain JSON mode and inline the sanitized schema as prompt
// guidance instead. The sidecar's Zod validation remains the authority.
export function makeJsonObjectRequest(
	args: Record<string, any>, legalActionTypes?: readonly string[]): Record<string, any> {
	const responseFormat = args.response_format as Record<string, unknown> | undefined;
	const jsonSchema = responseFormat?.json_schema as Record<string, unknown> | undefined;
	if (responseFormat?.type !== 'json_schema' || jsonSchema?.schema == null) {
		return args;
	}

	const result: Record<string, any> = { ...args, response_format: { type: 'json_object' } };
	const messages = args.messages;
	if (Array.isArray(messages) && messages.length > 0 && messages[0]?.role === 'system') {
		const schemaText = JSON.stringify(providerSafeSchema(narrowActionSchema(jsonSchema.schema, legalActionTypes)));
		result.messages = [
			{
				...messages[0],
				content: `${messages[0].content}\n\nRespond with exactly one JSON object that conforms to this JSON schema:\n${schemaText}`
			},
			...messages.slice(1)
		];
	}

	return result;
}
