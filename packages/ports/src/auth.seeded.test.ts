// T-0033: a seeded passkey is the same credential wherever it is built, and the simulator accepts it.
import { createECDH, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthSimulator } from './auth.simulator.ts';
import { p256PublicPoint, SeededPasskey } from './auth.seeded.ts';

describe('p256PublicPoint', () => {
  it('matches OpenSSL for many scalars', () => {
    for (let i = 0; i < 64; i++) {
      const d = createHash('sha256').update(`scalar-${i}`).digest();
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(d);
      const point = ecdh.getPublicKey(); // 0x04 || x || y
      const { x, y } = p256PublicPoint(BigInt(`0x${d.toString('hex')}`));
      expect([x.toString(16).padStart(64, '0'), y.toString(16).padStart(64, '0')]).toEqual([point.subarray(1, 33).toString('hex'), point.subarray(33).toString('hex')]);
    }
  });
});

describe('SeededPasskey', () => {
  it('registers with the simulator and then signs in, with a counter that keeps growing', async () => {
    const sim = new AuthSimulator();
    const passkey = await SeededPasskey.fromSeed('dana');
    const options = await sim.registrationOptions({ id: 'p1', name: 'Dana' });
    const credential = await sim.verifyRegistration(options, await passkey.register(options));
    let stored = credential;
    for (let i = 0; i < 3; i++) {
      const challenge = await sim.authenticationOptions([stored]);
      const result = await sim.verifyAuthentication(challenge, await passkey.authenticate(challenge), stored);
      expect(result.verified).toBe(true);
      if (result.verified) stored = { ...stored, counter: result.newCounter };
    }
  });

  it('is the same credential from every instance, and a different one per seed', async () => {
    const sim = new AuthSimulator();
    const options = await sim.registrationOptions({ id: 'p1', name: 'x' });
    const [a, b, other] = await Promise.all([SeededPasskey.fromSeed('noa'), SeededPasskey.fromSeed('noa'), SeededPasskey.fromSeed('maya')]);
    const [ra, rb, ro] = [await a.register(options), await b.register(options), await other.register(options)];
    expect(ra.credentialId).toBe(rb.credentialId);
    expect(ra.publicKey).toBe(rb.publicKey);
    expect(ro.credentialId).not.toBe(ra.credentialId);
    expect(ro.publicKey).not.toBe(ra.publicKey);
  });
});
