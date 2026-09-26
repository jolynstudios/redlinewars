/**
 * Live regional weather for the skirmish 'World' mode. Keyless, free, CORS-open
 * public endpoints only: ipwho.is for coarse region, Open-Meteo for current
 * conditions. Presentation-only mapping onto the sky's weather kinds — the
 * simulation never sees this, so lockstep stays deterministic.
 *
 * WMO weather_code → sky kinds:  0 clear · 2 rain · 3 snow
 * Temperature below freezing turns rain into snow. Wind scales onto the
 * presentation wind range (~120–900).
 */

export interface LiveWeather {
	kind: number
	intensity: number
	windSpeed: number
	summary: string
}

const TIMEOUT = 6000

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

/** WMO weather_code → presentation kind (0 clear, 2 rain, 3 snow) and intensity. */
function mapWeather(code: number, tempC: number, cloudCover: number): { kind: number; intensity: number } {
	if (code >= 95) return { kind: 2, intensity: 1000 } // thunderstorm
	if ((code >= 71 && code <= 77) || code === 85 || code === 86 || (code >= 51 && tempC <= 0))
		return { kind: 3, intensity: 720 } // snow
	if (code >= 51 || code >= 80) return { kind: 2, intensity: cloudCover >= 80 ? 880 : 640 } // rain
	if (cloudCover >= 70) return { kind: 0, intensity: 200 } // overcast stays dry-clear
	return { kind: 0, intensity: 0 }
}

export async function fetchLiveWeather(): Promise<LiveWeather> {
	const geo = (await getJson('https://ipwho.is/')) as {
		latitude?: number
		longitude?: number
		city?: string
		region?: string
	}
	const lat = geo?.latitude
	const lon = geo?.longitude
	const place = geo?.city || geo?.region || 'your area'
	if (typeof lat !== 'number' || typeof lon !== 'number') throw new Error('region unavailable')

	const w = (await getJson(
		`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
			'&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,is_day',
	)) as { current?: { temperature_2m?: number; weather_code?: number; cloud_cover?: number; wind_speed_10m?: number } }
	const c = w?.current ?? {}
	const code = Number(c.weather_code ?? 0)
	const temp = Number(c.temperature_2m ?? 10)
	const cloud = Number(c.cloud_cover ?? 0)
	const kmh = Number(c.wind_speed_10m ?? 10)
	const { kind, intensity } = mapWeather(code, temp, cloud)
	const windSpeed = Math.max(120, Math.min(900, Math.round(kmh * 15)))

	const conditions: Record<number, string> = {
		0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog',
		51: 'light drizzle', 53: 'drizzle', 55: 'drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
		66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
		80: 'rain showers', 81: 'rain showers', 82: 'violent showers', 85: 'snow showers', 86: 'snow showers',
		95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm',
	}
	const description = conditions[code] ?? 'mixed conditions'
	const snowing = kind === 3 ? ', snowing' : kind === 2 ? ', raining' : ''
	return { kind, intensity, windSpeed, summary: `${place} · ${Math.round(temp)}°C · ${description}${snowing}` }
}
