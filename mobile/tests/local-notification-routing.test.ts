import { shouldNotifyLocally } from '../src/realtime/notifications';

describe('who raises the notification for a socket event', () => {
  /**
   * The regression this guards. A foreground push is delivered and then
   * cancelled before Android displays it, so suppressing the local
   * notification whenever a token existed left a technician who was already
   * inside the app with no signal at all that another inspection had landed.
   */
  it('notifies locally in the foreground even with a push token registered', () => {
    expect(shouldNotifyLocally(true, 'active')).toBe(true);
  });

  it('leaves a backgrounded device to the server push, so nothing is shown twice', () => {
    // The socket can still be connected here, which is exactly how the same
    // event would arrive down both paths.
    expect(shouldNotifyLocally(true, 'background')).toBe(false);
    expect(shouldNotifyLocally(true, 'inactive')).toBe(false);
  });

  it('still notifies with no token in any state, because nothing else will', () => {
    expect(shouldNotifyLocally(false, 'active')).toBe(true);
    expect(shouldNotifyLocally(false, 'background')).toBe(true);
    expect(shouldNotifyLocally(false, 'inactive')).toBe(true);
  });
});
