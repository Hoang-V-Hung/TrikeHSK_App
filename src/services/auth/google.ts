import { NativeModules, Platform } from 'react-native';
import { googleWebClientId } from '../../../app.json';
import { isOffline } from '../offline/store';
import type { LoginResponse } from './types';

interface GoogleAuthBridge {
  signIn(clientId: string): Promise<string>;
  cancelSignIn(): void;
  signOut(): Promise<void>;
}
const native = NativeModules.GoogleAuth as GoogleAuthBridge | undefined;
export const APPROVAL_MESSAGE =
  'Tài khoản của bạn đang chờ quản trị viên duyệt. Bạn có thể đăng nhập sau khi được duyệt.';
export class AccountPendingApprovalError extends Error {
  constructor() {
    super(APPROVAL_MESSAGE);
    this.name = 'AccountPendingApprovalError';
  }
}
export async function requestGoogleIdToken(): Promise<string | null> {
  if (isOffline())
    throw new Error(
      'Đăng nhập Google cần kết nối mạng. Vui lòng kiểm tra lại kết nối.',
    );
  if (!['android', 'ios'].includes(Platform.OS) || !native)
    throw new Error(
      'Bản cài này chưa hỗ trợ đăng nhập Google. Vui lòng cài lại bản ứng dụng mới.',
    );
  try {
    const token = await native.signIn(googleWebClientId);
    if (typeof token !== 'string' || !token.trim())
      throw new Error('Google chưa trả thông tin đăng nhập. Vui lòng thử lại.');
    return token;
  } catch (error) {
    if ((error as { code?: string })?.code === 'CANCELLED') return null;
    throw error;
  }
}
export const cancelGoogleSignIn = () => native?.cancelSignIn();
export const clearGoogleSignIn = async () => {
  await native?.signOut().catch(() => undefined);
};

// A 202 pending response is a valid business result, never an authenticated session.
export function googleLoginSession(value: unknown): LoginResponse {
  const data = value as Partial<LoginResponse> & {
    status?: string;
    code?: string;
  };
  if (
    data?.status === 'pending_approval' ||
    data?.code === 'accountPendingApproval' ||
    Number(data?.user?.status?.id) === 3
  ) {
    throw new AccountPendingApprovalError();
  }
  if (
    !data?.user?.id ||
    typeof data.token !== 'string' ||
    !data.token ||
    typeof data.refreshToken !== 'string' ||
    !data.refreshToken ||
    !Number.isFinite(data.tokenExpires)
  ) {
    throw new Error(
      'Máy chủ chưa xác nhận được phiên đăng nhập Google. Vui lòng thử lại.',
    );
  }
  if (Number(data.user.status?.id) !== 1)
    throw new Error(
      'Tài khoản chưa được kích hoạt. Vui lòng liên hệ quản trị viên.',
    );
  return data as LoginResponse;
}
export async function pendingApprovalMessage(
  error: unknown,
): Promise<string | null> {
  if (error instanceof AccountPendingApprovalError) return APPROVAL_MESSAGE;
  const response = (error as { response?: Response })?.response;
  if (!response) return null;
  try {
    const body = await response.clone().json();
    return body?.code === 'accountPendingApproval' ||
      body?.status === 'pending_approval' ||
      body?.errors?.status === 'accountPendingApproval'
      ? APPROVAL_MESSAGE
      : null;
  } catch {
    return null;
  }
}
