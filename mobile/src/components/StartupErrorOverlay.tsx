import { Component, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { subscribeToFatalError, type FatalErrorReport } from '@/src/lib/error-log';

/**
 * TEMPORARY — diagnostic build only. Revert with the commit that added it.
 *
 * The Android app closed straight after the splash screen and left nothing to
 * read: no console, no crash reporter, and the in-memory error log dies with
 * the process. This puts the error on the screen instead.
 *
 * Deliberately built from nothing. Plain React Native primitives, inline
 * styles, no theme, no NativeWind, no hook from this app — because the thing it
 * has to describe may be the failure of exactly those. A diagnostic that shares
 * a dependency with the fault it reports is a diagnostic that shows a white
 * screen at the moment it is needed.
 *
 * Catches both shapes of failure. Render throws come through
 * `componentDidCatch`; fatal errors outside the tree arrive from the global
 * handler, which in this build no longer chains to React Native's default
 * handler — that default is what was terminating the process.
 *
 * If the app *still* closes with this installed, that is itself the answer: the
 * crash is native, below JavaScript, and no amount of JS handling will catch it.
 */
type State = { error: FatalErrorReport | null };

export class StartupErrorOverlay extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  private unsubscribe?: () => void;

  componentDidMount() {
    this.unsubscribe = subscribeToFatalError((error) => this.setState({ error }));
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  componentDidCatch(error: Error) {
    this.setState({
      error: { source: 'render', message: error.message, stack: error.stack },
    });
  }

  static getDerivedStateFromError(error: Error): State {
    return { error: { source: 'render', message: error.message, stack: error.stack } };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={{ flex: 1, backgroundColor: '#0C1E42', padding: 20, paddingTop: 64 }}>
        <Text style={{ color: '#FF8A8A', fontSize: 18, fontWeight: '700', marginBottom: 4 }}>
          Startup error
        </Text>
        <Text style={{ color: '#9FB3D9', fontSize: 12, marginBottom: 16 }}>
          Diagnostic build. Screenshot this whole screen.
        </Text>
        <Text style={{ color: '#FFFFFF', fontSize: 12, marginBottom: 2 }}>
          source: {error.source}
        </Text>
        <ScrollView style={{ flex: 1 }}>
          <Text selectable style={{ color: '#FFFFFF', fontSize: 13, marginBottom: 12 }}>
            {error.message}
          </Text>
          <Text selectable style={{ color: '#9FB3D9', fontSize: 11, lineHeight: 16 }}>
            {error.stack ?? '(no stack)'}
          </Text>
        </ScrollView>
      </View>
    );
  }
}
