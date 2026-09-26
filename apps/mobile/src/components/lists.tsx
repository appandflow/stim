// React Native's scroll views until https://github.com/software-mansion/react-native-gesture-handler/issues/4547 is
// fixed: on Android, inside Gesture Handler's ScrollView, a tap that only stops a fling fires the row's onPress.
export { FlatList, ScrollView, SectionList } from 'react-native';
