// Airalo adapter (T-0710): EsimPort. Flag: esim.airalo (config/flags.json).
export { AiraloEsimAdapter, appleInstallUrl, type AiraloEsimOptions } from './esim.ts';
export { AiraloClient, AiraloApiError, AiraloTransportError, type AiraloClientOptions } from './client.ts';
export { FakeAiralo, FAKE_AIRALO_FAILING_SKU, type FakeAiraloOptions } from './fake-airalo.ts';
