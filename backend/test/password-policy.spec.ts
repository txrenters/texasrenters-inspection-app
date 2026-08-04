// Must precede the DTO import: its decorators are evaluated at module load.
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { firstUnmetPasswordRule } from '@texasrenters/shared';

import { ChangeRequiredPasswordDto } from '../src/auth/auth.dto';

async function reject(password: string) {
  const errors = await validate(plainToInstance(ChangeRequiredPasswordDto, { password }));
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('required password policy', () => {
  it('accepts a password meeting every rule', async () => {
    expect(await reject('Aa1!aa')).toEqual([]);
  });

  it('names the rule that failed rather than rejecting anonymously', async () => {
    // The whole point of splitting these: a technician saw "Bad Request" and
    // had nothing to act on. Each message has to say which requirement is
    // missing.
    expect(await reject('Aa1!a')).toContain('Use at least 6 characters.');
    expect(await reject('aa1!aa')).toContain('Include at least one capital letter.');
    expect(await reject('Aaa!aa')).toContain('Include at least one number.');
    expect(await reject('Aa1aaa')).toContain('Include at least one special character.');
  });

  it('still names a rule when several are unmet', async () => {
    // class-validator keys constraints by validator name, so the three pattern
    // rules share one slot and only one of them is reported at a time. That is
    // acceptable because the app states every requirement before anything is
    // typed and checks them in order locally — the API is the backstop, and
    // what matters here is that it never falls back to "Bad Request".
    const messages = await reject('aaa');
    expect(messages).toContain('Use at least 6 characters.');
    expect(messages.some((message) => message.startsWith('Include at least one'))).toBe(true);
    expect(messages).not.toContain('Bad Request');
  });

  it('stops at bcrypt’s ceiling rather than silently ignoring the tail', async () => {
    expect(await reject(`Aa1!${'a'.repeat(69)}`)).toContain('Use no more than 72 characters.');
  });

  it('agrees with the shared rules the apps check against', async () => {
    // The drift this guards against is what a person hit twice: the app said a
    // password was fine and the API refused it. Both now read the same rules,
    // and this asserts the two paths reach the same verdict rather than merely
    // importing the same file.
    const samples = ['Aa1!aa', 'aa1!aa', 'Aaa!aa', 'Aa1aaa', 'Aa1!a', 'Kp7#mq2z'];
    for (const sample of samples) {
      const apiRejected = (await reject(sample)).length > 0;
      const appRejected = firstUnmetPasswordRule(sample) !== null;
      expect({ sample, apiRejected }).toEqual({ sample, apiRejected: appRejected });
    }
  });

  it('accepts a generated temporary password', async () => {
    // Provisioning builds one character from each of upper, lower, digit and
    // symbol, then pads to eight. It has to satisfy the policy it hands out.
    expect(await reject('Kp7#mq2z')).toEqual([]);
  });
});
