import { getJobberConfig } from '../src/integrations/jobber/jobber.config';

describe('the mirror switch', () => {
  it('is off unless JOBBER_MIRROR_ENABLED is exactly "true"', () => {
    expect(getJobberConfig({}).mirrorEnabled).toBe(false);
    expect(getJobberConfig({ JOBBER_MIRROR_ENABLED: 'TRUE' }).mirrorEnabled).toBe(false);
    expect(getJobberConfig({ JOBBER_MIRROR_ENABLED: 'true' }).mirrorEnabled).toBe(true);
  });
});
