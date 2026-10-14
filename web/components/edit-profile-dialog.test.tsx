import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditProfileDialog, type EditProfileDialogProps } from './edit-profile-dialog';

/**
 * Editing a person's name, sign-in email and phone (2026-10-14). Only what
 * changed is sent, so saving an untouched email cannot trip the server's
 * email rules, and the email warning appears the moment the address differs.
 */
function renderDialog(overrides: Partial<EditProfileDialogProps> = {}) {
  const props: EditProfileDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    profile: { displayName: 'Smauel Upchurch', email: 'sam@texasrenters.com', phone: null },
    emailLockedReason: null,
    matchedInJobber: true,
    onSave: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
    ...overrides,
  };
  render(<EditProfileDialog {...props} />);
  return props;
}

const save = () => screen.getByRole('button', { name: 'Save changes' });

describe('EditProfileDialog', () => {
  it('sends only the fields that changed, and closes once saved', async () => {
    const props = renderDialog();

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Samuel Upchurch' } });
    fireEvent.click(save());

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ displayName: 'Samuel Upchurch' }));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('sends a phone number in E.164, however it was typed', async () => {
    const props = renderDialog();

    fireEvent.change(screen.getByLabelText('Phone (optional)'), {
      target: { value: '(713) 555-0100' },
    });
    fireEvent.click(save());

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ phone: '+17135550100' }));
  });

  it('shows a stored number the way the office reads it, and clears it when emptied', async () => {
    const props = renderDialog({
      profile: { displayName: 'Sam', email: 'sam@texasrenters.com', phone: '+17135550100' },
    });

    const phone = screen.getByLabelText('Phone (optional)');
    expect(phone).toHaveValue('(713) 555-0100');
    fireEvent.change(phone, { target: { value: '' } });
    fireEvent.click(save());

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ phone: null }));
  });

  it('refuses a phone number it cannot read before anything is sent', () => {
    const props = renderDialog();

    fireEvent.change(screen.getByLabelText('Phone (optional)'), {
      target: { value: '713 555 0100 ext 4' },
    });

    expect(screen.getByText(/That is not a phone number we can read/)).toBeInTheDocument();
    expect(screen.getByLabelText('Phone (optional)')).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('keeps Save off until something changes', () => {
    renderDialog();
    expect(save()).toBeDisabled();
  });

  it('warns about sign-in and Jobber the moment the email differs', async () => {
    const props = renderDialog();
    expect(screen.queryByText(/Jobber matches visits/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Sign-in email'), {
      target: { value: 'samuel@texasrenters.com' },
    });

    expect(screen.getByText(/any reset link already sent to the old one stops working/)).toBeInTheDocument();
    expect(screen.getByText(/Jobber matches visits to technicians by email/)).toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({ email: 'samuel@texasrenters.com' }),
    );
  });

  it('leaves Jobber out of the warning for somebody Jobber does not schedule', () => {
    renderDialog({ matchedInJobber: false });

    fireEvent.change(screen.getByLabelText('Sign-in email'), {
      target: { value: 'samuel@texasrenters.com' },
    });

    expect(screen.getByText(/any reset link already sent/)).toBeInTheDocument();
    expect(screen.queryByText(/Jobber matches visits/)).toBeNull();
  });

  it('treats a change of letter case alone as no change', () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('Sign-in email'), {
      target: { value: 'SAM@texasrenters.com' },
    });

    expect(screen.queryByText(/any reset link already sent/)).toBeNull();
    expect(save()).toBeDisabled();
  });

  it('says why the email cannot be changed, and does not send it', async () => {
    const props = renderDialog({
      emailLockedReason: 'They also sign in to the console, so only someone who manages users can change this.',
    });

    expect(screen.getByLabelText('Sign-in email')).toBeDisabled();
    expect(screen.getByText(/only someone who manages users/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Samuel Upchurch' } });
    fireEvent.click(save());

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ displayName: 'Samuel Upchurch' }));
  });

  it('stays open and shows the refusal when the save fails', async () => {
    const props = renderDialog({
      onSave: vi.fn().mockRejectedValue(new Error('Another account already signs in with that email.')),
      error: new Error('Another account already signs in with that email.'),
    });

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Samuel Upchurch' } });
    fireEvent.click(save());

    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText('Another account already signs in with that email.')).toBeInTheDocument();
  });
});
