// @refresh reset
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createStackNavigator } from '@react-navigation/stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Paths } from '@/navigation/paths';
import type { RootStackParamList } from '@/navigation/types';
import { useTheme } from '@/theme';

import { Example, Login, Onboarding, Register, Startup, Survey, ForgotPassword, ResetPassword } from '@/screens';
import { BottomTabNavigator } from '@/navigation/BottomTabNavigator';
import { getAuthSessionVersion, isAuthenticated, subscribeAuthSession } from '@/services/storage';
import { AudioProvider } from '@/services/audio/AudioProvider';
import { useReducedMotion } from './useReducedMotion';
import { linking } from './linking';

const Stack = createStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function ApplicationNavigator() {
  const { navigationTheme, colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const [sessionVersion, setSessionVersion] = useState(getAuthSessionVersion);

  useEffect(() => subscribeAuthSession(() => {
    void queryClient.cancelQueries();
    queryClient.removeQueries();
    setSessionVersion(getAuthSessionVersion());
    if (!isAuthenticated() && navigationRef.isReady()) {
      navigationRef.resetRoot({ index: 0, routes: [{ name: Paths.Login }] });
    }
  }), [queryClient]);

  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef} linking={linking} theme={navigationTheme}>
        <AudioProvider>
        <Stack.Navigator
          initialRouteName={Paths.Startup} //
          screenOptions={{
            animation: reducedMotion ? 'none' : 'slide_from_right',
            cardStyle: { backgroundColor: colors.surface },
            freezeOnBlur: false,
            headerShown: false,
          }}
        >
          <Stack.Screen key={`tabs-${sessionVersion}`} component={BottomTabNavigator} name={Paths.MainTabs} options={{ animation: reducedMotion ? 'none' : 'fade' }} />
          <Stack.Screen component={Startup} name={Paths.Startup} options={{ animation: 'none' }} />
          <Stack.Screen component={Onboarding} name={Paths.Onboarding} />
          <Stack.Screen component={Login} name={Paths.Login} />
          <Stack.Screen component={Register} name={Paths.Register} />
          <Stack.Screen component={Survey} name={Paths.Survey} />
          <Stack.Screen component={ForgotPassword} name={Paths.ForgotPassword} />
          <Stack.Screen component={ResetPassword} name={Paths.ResetPassword} />
          <Stack.Screen component={Example} name={Paths.Example} />
        </Stack.Navigator>
        </AudioProvider>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default ApplicationNavigator;
