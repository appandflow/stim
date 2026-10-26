import { useLocalSearchParams } from 'expo-router';
import { OpenWorkspace } from '@/screens/open-workspace';

export default function OpenWorkspaceRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const query = new URLSearchParams();
  for (const [name, values] of Object.entries(params))
    for (const value of Array.isArray(values) ? values : [values]) query.append(name, value);
  return <OpenWorkspace query={query.toString()} />;
}
