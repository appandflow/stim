import { t } from '@lingui/core/macro';

import { formatBytes } from '@/intl/format';
import {
  needsAttention as sharedNeedsAttention,
  type AttentionMessage,
  type NeedsAttentionInput,
} from '@stim-cli/core/oversight';

export { STALE_MS, type NeedsAttentionInput, type NeedsAttentionItem } from '@stim-cli/core/oversight';

function languageName(language: string | undefined): string | undefined {
  switch (language) {
    case 'Swift':
      return t`Swift`;
    case 'Objective-C':
      return t`Objective-C`;
    case 'Objective-C++':
      return t`Objective-C++`;
    case 'Kotlin':
      return t`Kotlin`;
    case 'Java':
      return t`Java`;
    case 'C':
      return t`C`;
    case 'C++':
      return t`C++`;
    case 'JavaScript':
      return t`JavaScript`;
    case 'TypeScript':
      return t`TypeScript`;
    case 'Gradle':
      return t`Gradle`;
    default:
      return language;
  }
}

const platformName = (platform: string) => (platform === 'ios' ? 'iOS' : t`Android`);

function attentionBody(facts: AttentionMessage): string {
  switch (facts.kind) {
    case 'issue': {
      const { slot, message } = facts;
      return slot ? t`${slot}: ${message}` : message;
    }
    case 'signing': {
      const name = platformName(facts.platform);
      const { code } = facts;
      return t`${name} signing or provisioning failed (${code})`;
    }
    case 'diagnostic-loop': {
      const name = platformName(facts.platform);
      const language = languageName(facts.language);
      const { count, file } = facts;
      const line = String(facts.line);
      return language
        ? t`Same ${language} error ${count}x at ${file}:${line}`
        : t`Same ${name} build error ${count}x at ${file}:${line}`;
    }
    case 'launch-loop': {
      const name = platformName(facts.platform);
      const { count } = facts;
      return t`App failed to launch on ${name} ${count}x in a row`;
    }
    case 'build-loop': {
      const name = platformName(facts.platform);
      const { count, errorCode } = facts;
      return errorCode
        ? t`${name} build failed ${count}x in a row (${errorCode})`
        : t`${name} build failed ${count}x in a row`;
    }
    case 'lease': {
      const { leased } = facts;
      return t`Lease on ${leased} expired`;
    }
    case 'eas': {
      const { minutes } = facts;
      return t`EAS session running for ${minutes} min with no agent; billed while it runs`;
    }
    case 'stuck': {
      const { minutes } = facts;
      const green = facts.green ? platformName(facts.green) : null;
      const model =
        facts.modelLabel === 'ios-simulator'
          ? t`iOS Simulator`
          : facts.modelLabel === 'android-device'
            ? t`Android device`
            : facts.modelLabel === 'android-emulator'
              ? t`Android Emulator`
              : facts.modelLabel === 'chrome'
                ? t`Chrome`
                : facts.model;
      return green
        ? t`No agent activity for ${minutes} min after a green ${green} build; ${model} still up`
        : t`No agent activity for ${minutes} min; ${model} still up`;
    }
    case 'disk': {
      const free = formatBytes(facts.freeBytes);
      return t`${free} free, below Stim's floor`;
    }
  }
}

export function needsAttention(input: NeedsAttentionInput) {
  return sharedNeedsAttention(input, attentionBody);
}
