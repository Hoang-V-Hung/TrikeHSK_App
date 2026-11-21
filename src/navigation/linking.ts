import {
  getStateFromPath,
  type LinkingOptions,
} from '@react-navigation/native';

import { websiteUrl } from '../../app.json';
import { API_ORIGIN } from '@/services/config';
import { Paths } from './paths';
import type { RootStackParamList } from './types';

const resetPaths = new Set([
  'password-change',
  'reset-password',
  'api/v1/auth/password-change',
]);

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [
    'tricehsk://',
    'apphsk://',
    new URL(websiteUrl).origin,
    new URL(websiteUrl).origin.replace(/^https:/, 'http:'),
    API_ORIGIN,
  ],
  config: {
    initialRouteName: Paths.Login,
    screens: {
      [Paths.ResetPassword]: 'password-change',
      [Paths.Login]: 'login',
    },
  },
  getStateFromPath(path, options) {
    const [pathname, query = ''] = path.split('?', 2);
    const normalized = pathname.replace(/^\/+|\/+$/g, '');
    if (!resetPaths.has(normalized)) {
      return getStateFromPath<RootStackParamList>(path, options);
    }

    const search = new URLSearchParams(query.split('#', 1)[0]);
    const hashes = search.getAll('hash');
    const hash = hashes.length === 1 && hashes[0].length > 0 && hashes[0].length <= 4096
      ? hashes[0]
      : undefined;
    const email = search.get('email');
    const params = {
      ...(hash ? { hash } : {}),
      ...(email && email.length <= 255 ? { email } : {}),
    };

    // A login screen below the reset form gives cold starts a valid back route.
    return {
      index: 1,
      routes: [
        { name: Paths.Login },
        { name: Paths.ResetPassword, params },
      ],
    };
  },
};
