// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// INT-04: tests/server.mjs serves bin-browser/AppBundle, not the source tree.
// An era lock can therefore vouch for current sources while a stale wasm
// publish silently runs different code. This gate binds all three kinds of
// browser-build input to the artifacts that are actually served:
// - declared web assets are byte-identical;
// - the complete embedded VFS inventory and hashes match;
// - portable-PDB document hashes match every compiled C# source.
//
// The portable-PDB reader is compiled in a temporary directory from the
// installed .NET SDK. It has no package references and performs no network
// access. This gate deliberately does not rebuild the bundle: refreshing a
// stale artifact as a side effect would hide the defect it is meant to catch.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');
const browserRoot = path.join(repoRoot, 'OpenRA.Browser');
const bundleRoot = path.join(repoRoot, 'bin-browser', 'AppBundle');
const projectPath = path.join(browserRoot, 'OpenRA.Browser.csproj');
const bootPath = path.join(bundleRoot, '_framework', 'blazor.boot.json');

let checks = 0;
function ok(condition, message) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exit(1);
	}

	checks++;
	console.log(`ok: ${message}`);
}

const sha256SRI = bytes =>
	`sha256-${createHash('sha256').update(bytes).digest('base64')}`;

function declaredWebAssets(projectText) {
	const assets = new Set();
	const main = projectText.match(/<WasmMainJSPath>([^<]+)<\/WasmMainJSPath>/);
	if (main)
		assets.add(main[1]);

	for (const match of projectText.matchAll(/<WasmExtraFilesToDeploy Include="([^"]+)"\s*\/>/g))
		assets.add(match[1]);

	return [...assets].sort();
}

function embeddedSources() {
	const sources = new Map();
	// STEELSEED Tier 0 removed every legacy mod/content VFS tree. Keep this gate
	// aligned with the two non-content files that remain embedded until the
	// procedural mod node declares its generated inputs.
	sources.set('/openra/engine/VERSION', path.join(repoRoot, 'VERSION'));
	sources.set('/openra/browser/agent-rules.yaml', path.join(browserRoot, 'AgentMode', 'agent-rules.yaml'));
	return sources;
}

function flattenVfs(node, entries = new Map()) {
	for (const [name, value] of Object.entries(node ?? {})) {
		if (name.startsWith('/')) {
			const resourceEntries = Object.entries(value ?? {});
			if (resourceEntries.length !== 1)
				throw new Error(`${name} must resolve to exactly one bundled support file`);
			entries.set(name, resourceEntries[0][1]);
		} else if (value != null && typeof value === 'object')
			flattenVfs(value, entries);
	}

	return entries;
}

function resolveDotnet() {
	const onPath = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
	if (onPath.status === 0)
		return 'dotnet';

	const fallback = path.join(os.homedir(), '.dotnet', 'dotnet');
	if (existsSync(fallback) && spawnSync(fallback, ['--version'], { encoding: 'utf8' }).status === 0)
		return fallback;

	throw new Error('dotnet is required (checked PATH and ~/.dotnet/dotnet)');
}

const pdbVerifierSource = String.raw`
using System.Reflection.Metadata;
using System.Security.Cryptography;

static class Program
{
	static readonly string[] Projects =
	[
		"OpenRA.Browser",
		"OpenRA.Game",
		"OpenRA.Mods.Common",
		"OpenRA.Mods.Cnc",
		"OpenRA.Platforms.Browser"
	];

	static readonly Guid Sha1 = new("ff1816ec-aa5e-4d10-87f7-6f4963833460");
	static readonly Guid Sha256 = new("8829d00f-11b8-4213-878b-770e8597ac16");

	static int Main(string[] args)
	{
		if (args.Length != 2)
			throw new ArgumentException("expected <repo-root> <bundle-root>");

		var repoRoot = Path.GetFullPath(args[0]);
		var framework = Path.Combine(Path.GetFullPath(args[1]), "_framework");
		var expected = new HashSet<string>(StringComparer.Ordinal);
		foreach (var project in Projects)
		{
			var root = Path.Combine(repoRoot, project);
			foreach (var source in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
			{
				var relative = Path.GetRelativePath(repoRoot, source).Replace('\\', '/');
				if (!relative.Split('/').Any(segment => segment is "bin" or "obj"))
					expected.Add(relative);
			}
		}

		var verified = new HashSet<string>(StringComparer.Ordinal);
		foreach (var project in Projects)
		{
			var pdbPath = Path.Combine(framework, $"{project}.pdb");
			if (!File.Exists(pdbPath))
				throw new InvalidDataException($"served bundle is missing {project}.pdb");

			using var stream = File.OpenRead(pdbPath);
			using var provider = MetadataReaderProvider.FromPortablePdbStream(stream);
			var reader = provider.GetMetadataReader();
			foreach (var handle in reader.Documents)
			{
				var document = reader.GetDocument(handle);
				var relative = RepositoryRelative(reader.GetString(document.Name));
				if (relative == null)
					continue;
				if (relative.Split('/').Any(segment => segment is "bin" or "obj"))
					continue;

				var sourcePath = Path.Combine(repoRoot, relative.Replace('/', Path.DirectorySeparatorChar));
				if (!File.Exists(sourcePath))
					throw new InvalidDataException($"{project}.pdb names missing source {relative}");

				var algorithm = reader.GetGuid(document.HashAlgorithm);
				var bytes = File.ReadAllBytes(sourcePath);
				var actual = algorithm == Sha256 ? SHA256.HashData(bytes) :
					algorithm == Sha1 ? SHA1.HashData(bytes) :
					throw new InvalidDataException($"{relative} uses unsupported document hash {algorithm}");
				var locked = reader.GetBlobBytes(document.Hash);
				if (!actual.SequenceEqual(locked))
					throw new InvalidDataException($"{relative} differs from served {project}.pdb");

				verified.Add(relative);
			}
		}

		var absent = expected.Except(verified).Order().ToArray();
		var removed = verified.Except(expected).Order().ToArray();
		if (absent.Length > 0 || removed.Length > 0)
			throw new InvalidDataException(
				$"compiled source inventory drifted" +
				(absent.Length == 0 ? "" : $"; absent from PDB: {string.Join(", ", absent)}") +
				(removed.Length == 0 ? "" : $"; removed from tree: {string.Join(", ", removed)}"));

		Console.WriteLine($"verified {verified.Count} C# document hashes across {Projects.Length} assemblies");
		return 0;
	}

	static string? RepositoryRelative(string documentName)
	{
		var normalized = documentName.Replace('\\', '/');
		foreach (var project in Projects)
		{
			var marker = $"/{project}/";
			var index = normalized.LastIndexOf(marker, StringComparison.Ordinal);
			if (index >= 0)
				return normalized[(index + 1)..];
			if (normalized.StartsWith($"{project}/", StringComparison.Ordinal))
				return normalized;
		}

		return null;
	}
}
`;

function verifyPortablePdbSources() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), 'openra-bundle-freshness-'));
	try {
		const helperProject = path.join(tempDir, 'BundleFreshnessPdb.csproj');
		const helperSource = path.join(tempDir, 'Program.cs');
		writeFileSync(helperProject,
			'<Project Sdk="Microsoft.NET.Sdk">\n' +
			'\t<PropertyGroup>\n' +
			'\t\t<OutputType>Exe</OutputType>\n' +
			'\t\t<TargetFramework>net8.0</TargetFramework>\n' +
			'\t\t<ImplicitUsings>enable</ImplicitUsings>\n' +
			'\t\t<Nullable>enable</Nullable>\n' +
			'\t</PropertyGroup>\n' +
			'</Project>\n');
		writeFileSync(helperSource, pdbVerifierSource);

		const result = spawnSync(resolveDotnet(), [
			'run',
			'--project', helperProject,
			'--configuration', 'Release',
			'--', repoRoot, bundleRoot
		], {
			encoding: 'utf8',
			env: {
				...process.env,
				DOTNET_CLI_TELEMETRY_OPTOUT: '1',
				DOTNET_NOLOGO: '1',
				DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
				RestoreIgnoreFailedSources: 'true'
			}
		});
		if (result.status !== 0)
			throw new Error((result.stderr || result.stdout || `dotnet exited ${result.status}`).trim());

		return result.stdout.trim();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

try {
	ok(existsSync(path.join(bundleRoot, 'index.html')) &&
		existsSync(bootPath) &&
		existsSync(path.join(bundleRoot, '_framework', 'OpenRA.Browser.wasm')),
		'the server target is a complete published AppBundle');

	const projectText = readFileSync(projectPath, 'utf8');
	const webAssets = declaredWebAssets(projectText);
	const staleWebAssets = webAssets.filter(relative => {
		const source = path.join(browserRoot, relative);
		const served = path.join(bundleRoot, path.basename(relative));
		return !existsSync(served) || !readFileSync(source).equals(readFileSync(served));
	});
	ok(webAssets.length > 0 && staleWebAssets.length === 0,
		`all ${webAssets.length} declared web assets are byte-identical to the served bundle`);

	const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
	const actualVfs = flattenVfs(boot.resources?.vfs);
	const expectedVfs = embeddedSources(projectText);
	const missingVfs = [...expectedVfs.keys()].filter(name => !actualVfs.has(name));
	const removedVfs = [...actualVfs.keys()].filter(name => !expectedVfs.has(name));
	const staleVfs = [...expectedVfs].filter(([name, source]) =>
		actualVfs.get(name) !== sha256SRI(readFileSync(source)));
	ok(missingVfs.length === 0 && removedVfs.length === 0 && staleVfs.length === 0,
		`all ${expectedVfs.size} embedded VFS inputs match the served hash manifest`);

	const pdbResult = verifyPortablePdbSources();
	ok(/^verified \d+ C# document hashes across 5 assemblies$/.test(pdbResult),
		pdbResult || 'portable-PDB source verification returned no evidence');

	const serverText = readFileSync(path.join(testsDir, 'server.mjs'), 'utf8');
	ok(serverText.includes("path.join(repoRoot, 'bin-browser/AppBundle')"),
		'the checked artifact is the AppBundle served by the default test server');

	console.log(`bundle freshness gate passed (${checks} checks)`);
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exit(1);
}
