import android from '../fixtures/frame-android.jpg';
import androidMeta from '../fixtures/frame-android.json';
import iosTapped from '../fixtures/frame-ios-tapped.jpg';
import ios from '../fixtures/frame-ios.jpg';
import iosMeta from '../fixtures/frame-ios.json';
import notesAndroid from '../fixtures/frame-notes-android.jpg';
import notesAndroidMeta from '../fixtures/frame-notes-android.json';
import notesIosTapped from '../fixtures/frame-notes-ios-tapped.jpg';
import notesIos from '../fixtures/frame-notes-ios.jpg';
import notesIosMeta from '../fixtures/frame-notes-ios.json';
import notesMacos from '../fixtures/frame-notes-macos.jpg';
import notesMacosMeta from '../fixtures/frame-notes-macos.json';
import notesWeb from '../fixtures/frame-notes-web.jpg';
import notesWebMeta from '../fixtures/frame-notes-web.json';
import web from '../fixtures/frame-web.jpg';
import webMeta from '../fixtures/frame-web.json';
import logs from '../fixtures/logs.ndjson';
import machineDetails from '../fixtures/machine-details.json';
import plans from '../fixtures/plans.json';
import status from '../fixtures/status.json';
import { assembleFixtures, type Fixtures, type FixtureFiles } from './demo.ts';

const bytes = (data: ArrayBuffer): Uint8Array => new Uint8Array(data);

export function bundledFixtures(): Fixtures {
  return assembleFixtures({
    status: status as FixtureFiles['status'],
    logs,
    plans,
    machineDetails,
    frames: {
      ios: { meta: iosMeta, images: [bytes(ios), bytes(iosTapped)] },
      android: { meta: androidMeta, images: [bytes(android)] },
      web: { meta: webMeta, images: [bytes(web)] },
      'notes-ios': { meta: notesIosMeta, images: [bytes(notesIos), bytes(notesIosTapped)] },
      'notes-android': { meta: notesAndroidMeta, images: [bytes(notesAndroid)] },
      'notes-web': { meta: notesWebMeta, images: [bytes(notesWeb)] },
      'notes-macos': { meta: notesMacosMeta, images: [bytes(notesMacos)] },
    },
  });
}
