// Cover Genius (XCover) adapter (T-0720): InsurancePort. Flag: insurance.coverGenius (config/flags.json).
export { CoverGeniusInsuranceAdapter, mapBooking, type CoverGeniusInsuranceOptions, type CoverGeniusProduct } from './insurance.ts';
export { XCoverClient, XCoverApiError, XCoverTransportError, xcoverAuthorization, xcoverSignature, type XCoverClientOptions } from './client.ts';
export { FakeXCover, FAKE_XCOVER_OUTAGE_POLICY_TYPE, type FakeXCoverOptions } from './fake-xcover.ts';
