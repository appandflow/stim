import type { ReactNode } from 'react';
import CodeBlock from '@theme/CodeBlock';
import TabItem from '@theme/TabItem';
import Tabs from '@theme/Tabs';

const groupId = 'stim-invocation';
const managerGroupId = 'stim-package-manager';
const npxPrefix = 'npx stim';
const installCommands = [
  { value: 'npm', command: 'npm install --global stim' },
  { value: 'pnpm', command: 'pnpm add --global stim' },
  { value: 'bun', command: 'bun add --global stim' },
];

function normalize(code: string): string {
  return code.trim();
}

function toNpx(code: string): string {
  return normalize(code).replace(/\bstim(?=\s)/g, npxPrefix);
}

export default function StimTabs({ code }: { code: string }): ReactNode {
  const globalCode = normalize(code);

  return (
    <Tabs groupId={groupId} defaultValue="global">
      <TabItem value="global" label="Global">
        <CodeBlock language="bash">{globalCode}</CodeBlock>
      </TabItem>
      <TabItem value="npx" label="npx">
        <CodeBlock language="bash">{toNpx(globalCode)}</CodeBlock>
      </TabItem>
    </Tabs>
  );
}

export function StimInstallTabs(): ReactNode {
  return (
    <Tabs groupId={groupId} defaultValue="global">
      <TabItem value="global" label="Global">
        <Tabs groupId={managerGroupId} defaultValue="npm">
          {installCommands.map(({ value, command }) => (
            <TabItem key={value} value={value} label={value}>
              <CodeBlock language="bash">{`${command}
stim <command>`}</CodeBlock>
            </TabItem>
          ))}
        </Tabs>
      </TabItem>
      <TabItem value="npx" label="npx">
        <CodeBlock language="bash">{`${npxPrefix} <command>`}</CodeBlock>
      </TabItem>
    </Tabs>
  );
}
