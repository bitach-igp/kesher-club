// HTTP handlers for the auth operations in contracts/openapi.yaml (startOtp, verifyOtp,
// registerPasskey, authenticatePasskey, refreshToken, stepUp) plus the bearer middleware every
// other module uses. Handlers are pure functions over HttpRequest; see ../http.ts.
import { DomainError } from '@kesher/domain';
import type { PasskeyAuthenticationResponse, PasskeyRegistrationResponse } from '@kesher/ports';
import { created, ok, requirePrincipal, route, type Handler, type HttpRequest, type Principal } from '../http.ts';
import type { OtpService } from './otp.ts';
import type { PasskeyService } from './passkeys.ts';
import type { RecoveryService } from './recovery.ts';
import type { StepUpService } from './step-up.ts';
import type { TokenService } from './tokens.ts';

export interface AuthDeps {
  otp: OtpService;
  passkeys: PasskeyService;
  recovery: RecoveryService;
  tokens: TokenService;
  stepUp: StepUpService;
}

/**
 * Reads `Authorization: Bearer …`. An access JWT (three segments) is verified and becomes the
 * principal; a failing JWT is a hard 401. Opaque bearers (otp-session `otps_…`, refresh `rt_…`) are
 * left for the one handler that consumes them, so a public route never 401s on them by accident.
 */
export function bearerMiddleware(tokens: TokenService) {
  return async (req: HttpRequest): Promise<HttpRequest> => {
    const h = req.headers['authorization'];
    if (!h) return req;
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw new DomainError('UNAUTHENTICATED', 'Malformed Authorization header');
    if (m[1]!.split('.').length !== 3) return req;
    const principal: Principal = await tokens.verifyAccess(m[1]!);
    return { ...req, principal };
  };
}

const bearerToken = (req: HttpRequest): string => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers['authorization'] ?? '');
  if (!m) throw new DomainError('UNAUTHENTICATED', 'Bearer token required');
  return m[1]!;
};

/**
 * The install id both passkey ceremonies are keyed by (and refresh later names). Without it every
 * device would share one pending challenge and one device row, so it is refused, never defaulted.
 */
const deviceIdOf = (body: { deviceId?: unknown } | undefined): string => {
  const id = body?.deviceId;
  if (typeof id !== 'string' || id.length < 1 || id.length > 128) throw new DomainError('VALIDATION_FAILED', 'deviceId is required: 1 to 128 characters');
  return id;
};

export function authHandlers(deps: AuthDeps): Record<string, Handler> {
  const startOtp: Handler<{ phone: string; locale?: 'en' | 'he' }> = async (req) => created(await deps.otp.start({ phone: req.body.phone, locale: req.body.locale ?? 'en' }));

  const verifyOtp: Handler<{ otpId: string; code: string; purpose?: 'register' | 'recovery' }> = async (req) =>
    ok(await deps.otp.verify({ otpId: req.body.otpId, code: req.body.code, purpose: req.body.purpose ?? 'register' }));

  /** otp-session bearer for a new account; access bearer for adding a device; purpose=recovery runs recovery. */
  const registerPasskey: Handler<{ deviceId: string; deviceName?: string; response?: PasskeyRegistrationResponse; purpose?: 'register' | 'recovery' }> = async (req) => {
    const deviceId = deviceIdOf(req.body);
    const deviceName = req.body.deviceName ?? 'This device';
    if (req.principal) {
      return ok(await deps.passkeys.register({ principal: req.principal, deviceId, deviceName, ...(req.body.response ? { response: req.body.response } : {}) }));
    }
    const otpSessionToken = bearerToken(req);
    if (req.body.purpose === 'recovery') {
      return ok(await deps.recovery.recover({ otpSessionToken, deviceId, deviceName, ...(req.body.response ? { response: req.body.response } : {}) }));
    }
    return ok(await deps.passkeys.register({ otpSessionToken, deviceId, deviceName, ...(req.body.response ? { response: req.body.response } : {}) }));
  };

  const authenticatePasskey: Handler<{ deviceId: string; response?: PasskeyAuthenticationResponse }> = async (req) =>
    ok(await deps.passkeys.authenticate({ deviceId: deviceIdOf(req.body), ...(req.body.response ? { response: req.body.response } : {}) }));

  const refreshToken: Handler<{ deviceId: string }> = async (req) => ok(await deps.tokens.refresh(bearerToken(req), deviceIdOf(req.body)));

  const stepUp: Handler<{ response?: PasskeyAuthenticationResponse }> = async (req) => {
    const principal = requirePrincipal(req);
    if (!req.body?.response) return ok(await deps.stepUp.start(principal));
    return ok(await deps.stepUp.complete(principal, req.body.response));
  };

  return {
    startOtp: route(startOtp as Handler),
    verifyOtp: route(verifyOtp as Handler),
    registerPasskey: route(registerPasskey as Handler),
    authenticatePasskey: route(authenticatePasskey as Handler),
    refreshToken: route(refreshToken as Handler),
    stepUp: route(stepUp as Handler),
  };
}
