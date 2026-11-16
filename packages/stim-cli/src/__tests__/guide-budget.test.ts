import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { renderSection, renderTopic, sectionNames, topicNames } from '../commands/guide.ts';

interface Budget {
  skill: number;
  reactNativePath: number;
  defaults: { section: number; topic: number };
  topics: Record<string, number>;
  sections: Record<string, number>;
}

const budget: Budget = JSON.parse(readFileSync(new URL('./guide-budget.json', import.meta.url), 'utf-8'));

const bytes = (text: string | null): number => Buffer.byteLength(text ?? '', 'utf-8');

const SKILL = readFileSync(new URL('../../skill/SKILL.md', import.meta.url));

const HINT = 'Cut text, or raise the number in packages/stim-cli/src/__tests__/guide-budget.json in this pull request.';

function overages(entries: { name: string; size: number; budget: number }[]): string[] {
  return entries
    .filter((entry) => entry.size > entry.budget)
    .map(
      (entry) =>
        `${entry.name}: ${entry.size} bytes, budget ${entry.budget}, over by ${entry.size - entry.budget}. ${HINT}`,
    );
}

test('rendered guide and skill sizes stay within the checked-in budget', () => {
  const entries = [{ name: 'skill', size: SKILL.length, budget: budget.skill }];
  const unknown: string[] = [];
  const seenTopics = new Set<string>();
  const seenSections = new Set<string>();

  for (const topic of topicNames()) {
    seenTopics.add(topic);
    entries.push({
      name: `guide ${topic}`,
      size: bytes(renderTopic(topic)),
      budget: budget.topics[topic] ?? budget.defaults.topic,
    });
    for (const section of sectionNames(topic)) {
      const key = `${topic} ${section}`;
      seenSections.add(key);
      entries.push({
        name: `guide ${key}`,
        size: bytes(renderSection(topic, section)),
        budget: budget.sections[key] ?? budget.defaults.section,
      });
    }
  }

  for (const topic of Object.keys(budget.topics)) {
    if (!seenTopics.has(topic)) unknown.push(`budget names topic "${topic}", which does not exist. Remove the entry.`);
  }
  for (const key of Object.keys(budget.sections)) {
    if (!seenSections.has(key)) unknown.push(`budget names section "${key}", which does not exist. Remove the entry.`);
  }

  const router = bytes(renderTopic('agent'));
  const reactNative = bytes(renderSection('agent', 'react-native'));
  entries.push({
    name: 'normal React Native path (skill + guide agent + guide agent react-native)',
    size: SKILL.length + router + reactNative,
    budget: budget.reactNativePath,
  });

  expect([...overages(entries), ...unknown]).toEqual([]);
});
