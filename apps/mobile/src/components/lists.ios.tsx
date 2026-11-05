import { SectionList as RNSectionList, type SectionListProps } from 'react-native';
import { FlatList, ScrollView } from 'react-native-gesture-handler';

export { FlatList, ScrollView };

export function SectionList<ItemT, SectionT>(props: SectionListProps<ItemT, SectionT>) {
  return <RNSectionList {...props} renderScrollComponent={(scrollProps) => <ScrollView {...scrollProps} />} />;
}
