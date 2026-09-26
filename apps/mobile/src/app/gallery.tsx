import { Redirect } from 'expo-router';

import { Gallery } from '@/screens/gallery';

export default function GalleryRoute() {
  return __DEV__ ? <Gallery /> : <Redirect href="/" />;
}
