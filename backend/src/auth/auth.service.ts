import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class AuthService {
  async changeRequiredPassword(authUserId: string, password: string) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey)
      throw new ServiceUnavailableException('Password management is not configured.');

    const admin = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }).auth.admin;
    const current = await admin.getUserById(authUserId);
    if (current.error || !current.data.user)
      throw new BadGatewayException('The password could not be updated.');
    if (current.data.user.app_metadata.must_change_password !== true)
      throw new ForbiddenException('This account does not require a password replacement.');

    const updated = await admin.updateUserById(authUserId, {
      password,
      app_metadata: {
        ...current.data.user.app_metadata,
        must_change_password: false,
      },
    });
    if (updated.error) throw new BadGatewayException('The password could not be updated.');
  }
}
