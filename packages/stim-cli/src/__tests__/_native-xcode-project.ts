import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeNativeXcodeProject(
  root: string,
  name = 'Native',
  sdk = 'iphoneos',
  product = 'application',
): string {
  const project = join(root, `${name}.xcodeproj`);
  mkdirSync(join(project, 'xcshareddata', 'xcschemes'), { recursive: true });
  writeFileSync(join(root, `${name}.swift`), `struct ${name}App {}\n`);
  writeFileSync(
    join(project, 'project.pbxproj'),
    `// !$*UTF8*$!
{
archiveVersion = 1;
objectVersion = 54;
objects = {
PROJECT = { isa = PBXProject; mainGroup = GROUP; buildConfigurationList = CONFIGURATIONS; targets = ( APP, ); };
GROUP = { isa = PBXGroup; children = ( SOURCE, ); sourceTree = "<group>"; };
SOURCE = { isa = PBXFileReference; path = ${name}.swift; sourceTree = "<group>"; };
APP = { isa = PBXNativeTarget; name = ${name}; productType = "com.apple.product-type.${product}"; buildConfigurationList = CONFIGURATIONS; };
CONFIGURATIONS = { isa = XCConfigurationList; buildConfigurations = ( DEBUG, RELEASE, CUSTOM, ); defaultConfigurationName = Debug; };
DEBUG = { isa = XCBuildConfiguration; name = Debug; buildSettings = { SDKROOT = ${sdk}; PRODUCT_BUNDLE_IDENTIFIER = org.example.${name}; }; };
RELEASE = { isa = XCBuildConfiguration; name = Release; buildSettings = { SDKROOT = ${sdk}; PRODUCT_BUNDLE_IDENTIFIER = org.example.${name}; }; };
CUSTOM = { isa = XCBuildConfiguration; name = Staging; buildSettings = { SDKROOT = ${sdk}; PRODUCT_BUNDLE_IDENTIFIER = org.example.${name}; }; };
};
rootObject = PROJECT;
}
`,
  );
  writeFileSync(
    join(project, 'xcshareddata', 'xcschemes', `${name}.xcscheme`),
    `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.7"><LaunchAction buildConfiguration="Debug"><BuildableProductRunnable><BuildableReference BlueprintIdentifier="APP" ReferencedContainer="container:${name}.xcodeproj" /></BuildableProductRunnable></LaunchAction></Scheme>\n`,
  );
  return project;
}
