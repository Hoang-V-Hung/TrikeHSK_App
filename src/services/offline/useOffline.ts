import { useEffect, useSyncExternalStore } from 'react';
import { AppState, NativeEventEmitter } from 'react-native';
import {
  focusManager,
  onlineManager,
  type QueryClient,
} from '@tanstack/react-query';
import { subscribeAuthSession } from '../storage';
import { offlineFiles, warmLessonMedia } from './cache';
import { API_BASE_URL } from '../config';
import {
  getPendingEvents,
  getConnected,
  isOffline,
  offlineRevision,
  setConnected,
  setBackendReachable,
  subscribeOffline,
} from './store';
import { syncOfflineEvents } from './sync';

export const useOffline = () =>
  useSyncExternalStore(subscribeOffline, offlineRevision, offlineRevision);
export const useIsOffline = () =>
  useSyncExternalStore(subscribeOffline, isOffline, isOffline);

export function useOfflineRuntime(client: QueryClient) {
  useEffect(() => {
    let alive = true;
    let networkRevision = 0;
    let probing = false;
    let probeController: AbortController | undefined;
    const probe = async () => {
      if (probing) return;
      probing = true;
      const revision = networkRevision;
      const controller = new AbortController();
      probeController = controller;
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        // No token, no data writes: even a 404 proves the API host can be reached.
        const response = await fetch(API_BASE_URL, {
          method: 'HEAD',
          signal: controller.signal,
        });
        if (alive && revision === networkRevision)
          setBackendReachable(response.status < 500);
      } catch {
        if (alive && revision === networkRevision) setBackendReachable(false);
      } finally {
        clearTimeout(timeout);
        probing = false;
        if (alive && getConnected() && revision !== networkRevision)
          void probe();
        else if (alive && !isOffline()) void warmLessonMedia(null);
      }
    };
    const refresh = () => {
      if (!offlineFiles) {
        void probe();
        return;
      }
      const before = networkRevision;
      void offlineFiles
        ?.isConnected()
        .then((value) => {
          if (alive && before === networkRevision) {
            setConnected(value);
            if (value) void probe();
          }
        })
        .catch(() => undefined);
    };
    const connection = offlineFiles
      ? new NativeEventEmitter(offlineFiles as never).addListener(
          'hskOfflineConnection',
          (value: boolean) => {
            networkRevision += 1;
            setConnected(value);
            if (value) void probe();
          },
        )
      : undefined;
    let wasOffline = isOffline();
    let previousPending = getPendingEvents().length;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const synchronize = () => syncOfflineEvents();
    const changed = () => {
      const offline = isOffline();
      const changedMode = wasOffline !== offline;
      wasOffline = offline;
      const pending = getPendingEvents().length;
      if (pending < previousPending && !offline) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (!alive) return;
          void client.invalidateQueries({ queryKey: ['analytics'] });
          void client.invalidateQueries({ queryKey: ['auth', 'profile'] });
          void client.invalidateQueries({ queryKey: ['leaderboard'] });
        }, 250);
      }
      previousPending = pending;
      onlineManager.setOnline(!offline);
      if (changedMode) {
        void client.invalidateQueries();
        if (!offline) {
          void synchronize();
          void warmLessonMedia(null);
        }
      }
    };
    const unsubscribe = subscribeOffline(changed);
    const auth = subscribeAuthSession(() => {
      refresh();
      void synchronize();
    });
    const foreground = AppState.addEventListener('change', (state) => {
      focusManager.setFocused(state === 'active');
      if (state === 'active') {
        refresh();
        void synchronize();
      }
    });
    const retry = setInterval(() => {
      if (AppState.currentState === 'active') {
        refresh();
        void synchronize();
      }
    }, 30000);
    refresh();
    changed();
    void synchronize();
    return () => {
      alive = false;
      probeController?.abort();
      connection?.remove();
      foreground.remove();
      auth();
      unsubscribe();
      clearInterval(retry);
      clearTimeout(refreshTimer);
    };
  }, [client]);
}
