import { createHash } from 'node:crypto';
import type { BuildArtifactIdentity, BuildReactNativeArtifactQuery, BuildStimIdentity } from './protocol.ts';
import { isJsonObject } from './state/json-file.ts';

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
const path = (value: unknown): value is string =>
  text(value) &&
  !/[\\:]/.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '..' && part !== '.git');

/** `compat` when `value` has a valid one, else its `stimBuild`; null without either. */
export function stimIdentity(value: Record<string, unknown>): BuildStimIdentity | null {
  const { compat } = value;
  if (compat !== undefined)
    return typeof compat === 'number' && Number.isSafeInteger(compat) && compat > 0 ? { compat } : null;
  return text(value.stimBuild) ? { stimBuild: value.stimBuild } : null;
}

/** Validates and canonicalizes the choices used by completed React Native peer artifacts. */
export function reactNativeArtifactQuery(value: unknown): BuildReactNativeArtifactQuery | null {
  if (
    !isJsonObject(value) ||
    typeof value.project !== 'string' ||
    (value.project !== '' && !path(value.project)) ||
    !text(value.fingerprint) ||
    typeof value.isExpo !== 'boolean' ||
    Object.keys(value).some(
      (key) => !['project', 'fingerprint', 'isExpo', 'platform', 'toolchain', 'ios', 'android'].includes(key),
    )
  )
    return null;
  const tools = value.toolchain;
  const stim = isJsonObject(tools) ? stimIdentity(tools) : null;
  if (!isJsonObject(tools) || !stim) return null;
  const common = { project: value.project, fingerprint: value.fingerprint, isExpo: value.isExpo };
  if (value.platform === 'ios' && value.android === undefined && isJsonObject(value.ios)) {
    const { runtime, configuration, scheme, projectPath, optimizations } = value.ios;
    if (
      !text(tools.arch) ||
      !text(tools.xcode) ||
      !text(tools.simulatorSdk) ||
      !text(tools.cocoapods) ||
      !text(runtime) ||
      !text(configuration) ||
      /release/i.test(configuration) ||
      (scheme !== null && !text(scheme)) ||
      !path(projectPath) ||
      !isJsonObject(optimizations) ||
      typeof optimizations.compilationCache !== 'boolean' ||
      (optimizations.swiftCompilationCache !== null && typeof optimizations.swiftCompilationCache !== 'boolean') ||
      typeof optimizations.prefixMapping !== 'boolean' ||
      Object.keys(value.ios).some(
        (key) => !['runtime', 'configuration', 'scheme', 'projectPath', 'optimizations'].includes(key),
      ) ||
      Object.keys(optimizations).some(
        (key) => !['compilationCache', 'swiftCompilationCache', 'prefixMapping'].includes(key),
      )
    )
      return null;
    return {
      ...common,
      platform: 'ios',
      toolchain: {
        ...stim,
        arch: tools.arch,
        xcode: tools.xcode,
        simulatorSdk: tools.simulatorSdk,
        cocoapods: tools.cocoapods,
      },
      ios: {
        runtime,
        configuration,
        scheme,
        projectPath,
        optimizations: {
          compilationCache: optimizations.compilationCache,
          swiftCompilationCache: optimizations.swiftCompilationCache ?? false,
          prefixMapping: optimizations.prefixMapping,
        },
      },
    };
  }
  if (value.platform === 'android' && value.ios === undefined && isJsonObject(value.android)) {
    const { variant, abi, gradleBuildCache, pch, compilerCache, gradleRoot = null, module = null } = value.android;
    if (
      !text(tools.jdk) ||
      (variant !== null && (!text(variant) || !/^[A-Za-z0-9_-]+$/.test(variant) || /release/i.test(variant))) ||
      (abi !== null && (!text(abi) || !/^[A-Za-z0-9_-]+$/.test(abi))) ||
      typeof gradleBuildCache !== 'boolean' ||
      (compilerCache !== 'ccache' && compilerCache !== 'none') ||
      (gradleRoot !== null && !path(gradleRoot)) ||
      (module !== null && (!text(module) || !/^(:(?!\.\.?(?::|$))[A-Za-z0-9._-]+){1,20}$/.test(module))) ||
      Object.keys(value.android).some(
        (key) => !['variant', 'abi', 'gradleBuildCache', 'pch', 'compilerCache', 'gradleRoot', 'module'].includes(key),
      )
    )
      return null;
    if (pch !== 'auto' && pch !== 'on' && pch !== 'off') return null;
    return {
      ...common,
      platform: 'android',
      toolchain: { ...stim, jdk: tools.jdk },
      android: {
        variant: variant ?? 'debug',
        abi: abi === 'all' ? null : abi,
        gradleBuildCache,
        pch,
        compilerCache,
        gradleRoot: gradleRoot ?? 'android',
        module: module ?? ':app',
      },
    };
  }
  return null;
}

/** The identity of a canonical React Native query and the toolchain verified around its build. */
export function reactNativeArtifactIdentity(receipt: {
  query: BuildReactNativeArtifactQuery;
  toolchain: object;
}): BuildArtifactIdentity {
  const fingerprint = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  return { fingerprint, cacheKey: `react-native-${receipt.query.platform}-${fingerprint}` };
}
