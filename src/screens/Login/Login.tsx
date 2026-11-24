import type { RootScreenProps } from '@/navigation/types';

import React, { useEffect, useRef, useState } from 'react';
import { AppAlert } from '@/services/feedback/appAlert';
import {
  cancelGoogleSignIn,
  pendingApprovalMessage,
  requestGoogleIdToken,
} from '@/services/auth/google';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Paths } from '@/navigation/paths';
import { useTheme, hs, vs, ms } from '@/theme';
import { Button, Logo } from '@/components/atoms';
import {
  InputField,
  AuthDivider,
  GoogleSignInButton,
} from '@/components/molecules';
import { SafeScreen } from '@/components/templates';

import InputError from '@/components/atoms/InputError';
import { getFormErrors, validateEmail } from '@/services/auth/formErrors';
import type { FormErrors } from '@/services/auth/formErrors';
import { useLogin } from '@/services/auth';
import { hasCompletedSurvey } from '@/services/storage';

function Login({ navigation }: RootScreenProps<Paths.Login>) {
  const { colors, fonts, gutters, layout } = useTheme();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const loginMutation = useLogin();

  const [googleBusy, setGoogleBusy] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const isBusy = googleBusy || loginMutation.isPending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelGoogleSignIn();
    };
  }, []);
  const reportError = async (error: unknown) => {
    const approval = await pendingApprovalMessage(error);
    if (!mounted.current) return;
    if (approval) {
      AppAlert.info('Tài khoản đang chờ duyệt', approval, [
        { text: 'Đã hiểu' },
      ]);
      return;
    }
    const message = await getFormErrors(
      error,
      'Đăng nhập không thành công. Vui lòng thử lại.',
    );
    if (mounted.current) setErrors(message);
  };
  const finishLogin = async (
    dto: { email: string; password: string } | { idToken: string },
  ) => {
    const { user } = await loginMutation.mutateAsync(dto);
    if (mounted.current)
      navigation.reset({
        index: 0,
        routes: [
          { name: hasCompletedSurvey(user.id) ? Paths.MainTabs : Paths.Survey },
        ],
      });
  };
  const handleLogin = async () => {
    if (busy.current || isBusy) return;
    const trimmedEmail = email.trim();
    const nextErrors: FormErrors = {
      email: validateEmail(trimmedEmail),
      password: !password ? 'Vui lòng nhập mật khẩu.' : undefined,
    };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    busy.current = true;
    try {
      await finishLogin({ email: trimmedEmail, password });
    } catch (error) {
      await reportError(error);
    } finally {
      busy.current = false;
    }
  };
  const handleGoogleLogin = async () => {
    if (busy.current || isBusy) return;
    busy.current = true;
    setGoogleBusy(true);
    setErrors({});
    try {
      const idToken = await requestGoogleIdToken();
      if (idToken && mounted.current) await finishLogin({ idToken });
    } catch (error) {
      await reportError(error);
    } finally {
      busy.current = false;
      if (mounted.current) setGoogleBusy(false);
    }
  };

  return (
    <SafeScreen style={{ backgroundColor: '#FFFFFF' }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[layout.flex_1]}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: hs(24),
            paddingTop: vs(40),
            paddingBottom: vs(20),
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View
            style={[
              layout.row,
              layout.justifyBetween,
              layout.itemsCenter,
              gutters.marginBottom_40,
            ]}
          >
            <Logo variant="primary" />
            <TouchableOpacity
              disabled={isBusy}
              activeOpacity={0.7}
              onPress={() => navigation.navigate(Paths.Register)}
              style={{
                borderColor: colors.primary,
                borderRadius: ms(20),
                borderWidth: 1.5,
                paddingHorizontal: hs(14),
                paddingVertical: vs(6),
              }}
            >
              <Text
                style={{
                  color: colors.primary,
                  fontSize: ms(12),
                  fontWeight: '600',
                }}
              >
                Chưa có tài khoản?
              </Text>
            </TouchableOpacity>
          </View>

          {/* Title */}
          <Text
            style={[
              fonts.bold,
              {
                color: '#000000',
                fontSize: ms(22),
                marginBottom: vs(32),
              },
            ]}
          >
            Chào mừng bạn đã quay trở lại
          </Text>

          {/* Input Fields */}
          <View style={{ marginBottom: vs(28) }}>
            <InputField
              editable={!isBusy}
              autoCapitalize="none"
              iconType="mail"
              keyboardType="email-address"
              error={errors.email}
              onChangeText={(value) => {
                setEmail(value);
                setErrors((current) => ({
                  ...current,
                  email: undefined,
                  form: undefined,
                }));
              }}
              placeholder="Email"
              containerStyle={{ marginBottom: vs(16) }}
              value={email}
            />
            <InputField
              editable={!isBusy}
              iconType="lock"
              error={errors.password}
              onChangeText={(value) => {
                setPassword(value);
                setErrors((current) => ({
                  ...current,
                  password: undefined,
                  form: undefined,
                }));
              }}
              placeholder="Mật khẩu"
              secureTextEntry
              value={password}
            />
            <InputError message={errors.form} />
            <TouchableOpacity
              disabled={isBusy}
              style={{ alignSelf: 'flex-end', marginTop: vs(12) }}
              onPress={() => navigation.navigate(Paths.ForgotPassword)}
            >
              <Text
                style={{
                  color: '#1E40AF',
                  fontSize: ms(14),
                  fontWeight: '600',
                }}
              >
                Quên mật khẩu?
              </Text>
            </TouchableOpacity>
          </View>

          {/* Main Action Button */}
          <Button
            fullWidth
            disabled={isBusy}
            loading={loginMutation.isPending && !googleBusy}
            onPress={handleLogin}
            title="Đăng nhập"
            variant="primary"
          />

          {/* Divider "HOẶC" */}
          <AuthDivider />

          {/* Google Sign-in */}
          <GoogleSignInButton
            loading={googleBusy}
            disabled={isBusy}
            onPress={handleGoogleLogin}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}

export default Login;
