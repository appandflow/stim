/*!
 * Launchd service labels and categories ported from SimSlim
 * (https://github.com/MobAI-App/simslim, v0.14.0).
 *
 * MIT License
 *
 * Copyright (c) 2026 Interlap
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface SimSlimCategory {
  id: string;
  name: string;
  downside: string;
  labels: readonly string[];
}

export interface SimSlimFeature {
  id: string;
  name: string;
  labels: readonly string[];
}

export const SIM_SLIM_CATEGORIES: readonly SimSlimCategory[] = [
  {
    id: 'widgets',
    name: 'Widgets & Wallpaper',
    downside: 'Home and Lock Screen widgets, wallpaper posters, and Live Activities stop updating.',
    labels: ['com.apple.PosterBoard', 'com.apple.chronod', 'com.apple.liveactivitiesd', 'com.apple.navd'],
  },
  {
    id: 'siri',
    name: 'Siri & Intelligence',
    downside: 'Siri, speech features, and Apple Intelligence services are unavailable.',
    labels: [
      'com.apple.assistant_cdmd',
      'com.apple.assistant_service',
      'com.apple.siriactionsd',
      'com.apple.siriinferenced',
      'com.apple.siriknowledged',
      'com.apple.sirittsd',
      'com.apple.siri.context.service',
      'com.apple.siri.acousticsignature',
      'com.apple.corespeechd',
      'com.apple.voiced',
      'com.apple.voicebankingd',
      'com.apple.speechmodeltrainingd',
      'com.apple.intelligenceplatformd',
      'com.apple.intelligencecontextd',
      'com.apple.intelligenceflowd',
      'com.apple.intelligencetasksd',
      'com.apple.generativeexperiencesd',
      'com.apple.knowledgeconstructiond',
      'com.apple.naturallanguaged',
      'com.apple.textunderstandingd',
      'com.apple.modelcatalogd',
      'com.apple.modelmanagerd',
      'com.apple.mlhostd',
      'com.apple.mlruntimed',
      'com.apple.suggestd',
      'com.apple.parsecd',
      'com.apple.parsec-fbf',
      'com.apple.proactiveeventtrackerd',
    ],
  },
  {
    id: 'search',
    name: 'Spotlight & Search',
    downside:
      'Spotlight and Settings search return no results, and Recents in Files and the document picker fails to load.',
    labels: [
      'com.apple.searchd',
      'com.apple.searchtoold',
      'com.apple.spotlightknowledged',
      'com.apple.spotlightknowledged.updater',
      'com.apple.corespotlightservice',
    ],
  },
  {
    id: 'icloud',
    name: 'iCloud & Apple Account',
    downside: 'iCloud sync, Apple Account, Keychain, and backup workflows will not work.',
    labels: [
      'com.apple.appleaccountd',
      'com.apple.appleaccounttransparencyd',
      'com.apple.appleidsetupd',
      'com.apple.akd',
      'com.apple.amsaccountsd',
      'com.apple.amsengagementd',
      'com.apple.amsondevicestoraged',
      'com.apple.cloudd',
      'com.apple.cloudphotod',
      'com.apple.ckdiscretionaryd',
      'com.apple.cloudsettingssyncagent',
      'com.apple.bird',
      'com.apple.syncdefaultsd',
      'com.apple.cdpd',
      'com.apple.sosd',
      'com.apple.SecureBackupDaemon',
      'com.apple.TrustedPeersHelper',
      'com.apple.protectedcloudstorage.protectedcloudkeysyncing',
      'com.apple.icloudmailagent',
      'com.apple.icloudsubscriptionoptimizerd',
      'com.apple.communicationtrustd',
    ],
  },
  {
    id: 'store',
    name: 'App Store, Push & Media',
    downside: 'Remote push notifications and StoreKit or App Store testing will not work.',
    labels: [
      'com.apple.appstored',
      'com.apple.appstorecomponentsd',
      'com.apple.apsd',
      'com.apple.itunescloudd',
      'com.apple.itunesstored',
      'com.apple.storekitd',
      'com.apple.amsaccountsd',
      'com.apple.amsengagementd',
      'com.apple.amsondevicestoraged',
      'com.apple.passd',
      'com.apple.financed',
      'com.apple.videosubscriptionsd',
      'com.apple.assetsubscriptiond',
      'com.apple.musicd',
    ],
  },
  {
    id: 'pim',
    name: 'Mail, Calendar & Contacts',
    downside: 'Contacts, Calendar, Reminders, and Mail-backed pickers or sync may fail.',
    labels: [
      'com.apple.email.maild',
      'com.apple.exchangesyncd',
      'com.apple.dataaccess.dataaccessd',
      'com.apple.calaccessd',
      'com.apple.remindd',
      'com.apple.contactsd',
      'com.apple.contacts.postersyncd',
      'com.apple.peopled',
    ],
  },
  {
    id: 'web',
    name: 'Safari Sync & Web Services',
    downside: 'Universal links and Safari sync or background web services will not work.',
    labels: [
      'com.apple.SafariBookmarksSyncAgent',
      'com.apple.Safari.History',
      'com.apple.Safari.passwordbreachd',
      'com.apple.Safari.SafeBrowsing.Service',
      'com.apple.safarifetcherd',
      'com.apple.WebBookmarks.webbookmarksd',
      'com.apple.webkit.adattributiond',
      'com.apple.webkit.webpushd',
      'com.apple.webprivacyd',
      'com.apple.swcd',
    ],
  },
  {
    id: 'family',
    name: 'Family & Screen Time',
    downside: 'Family Sharing, Screen Time, and usage tracking stop working.',
    labels: [
      'com.apple.familycircled',
      'com.apple.FamilyControlsAgent',
      'com.apple.familynotification',
      'com.apple.askpermissiond',
      'com.apple.asktod',
      'com.apple.ScreenTimeAgent',
      'com.apple.ScreenTimeSettingsAgent',
      'com.apple.UsageTrackingAgent',
    ],
  },
  {
    id: 'health',
    name: 'Health, Home & Fitness',
    downside: 'HealthKit, HomeKit, and Fitness integrations will not work.',
    labels: [
      'com.apple.healthd',
      'com.apple.healthappd',
      'com.apple.healthcontentd',
      'com.apple.healtheventsd',
      'com.apple.healthrecordsd',
      'com.apple.finhealthd',
      'com.apple.homed',
      'com.apple.homeeventsd',
      'com.apple.fitcore',
      'com.apple.fitcore.session',
      'com.apple.fitnesscoachingd',
      'com.apple.fitnessintelligenced',
      'com.apple.activityawardsd',
      'com.apple.activitysharingd',
    ],
  },
  {
    id: 'photos',
    name: 'Photos & Media Analysis',
    downside: 'Photo picker, Photos-library workflows, and media analysis may fail.',
    labels: [
      'com.apple.photoanalysisd',
      'com.apple.photosface',
      'com.apple.mediaanalysisd',
      'com.apple.mediaanalysisd.service',
      'com.apple.mediastream.mstreamd',
      'com.apple.medialibraryd',
      'com.apple.assetsd',
      'com.apple.assetsd.nebulad',
    ],
  },
  {
    id: 'apps',
    name: 'News, Weather, Maps & Games',
    downside: 'News, Weather, Maps background data, and game-controller services are unavailable.',
    labels: [
      'com.apple.newsd',
      'com.apple.weatherd',
      'com.apple.Maps.mapssyncd',
      'com.apple.Maps.mapspushd',
      'com.apple.Maps.geocorrectiond',
      'com.apple.maps.destinationd',
      'com.apple.MapKit.SnapshotService',
      'com.apple.jetpackassetd',
      'com.apple.tipsd',
      'com.apple.gamesaved',
      'com.apple.GameController.gamecontrollerd',
    ],
  },
  {
    id: 'messaging',
    name: 'Messaging & FaceTime',
    downside: 'iMessage, FaceTime, and related identity services will not work.',
    labels: [
      'com.apple.identityservicesd',
      'com.apple.ids_simd',
      'com.apple.imautomatichistorydeletionagent',
      'com.apple.imcore.imtransferagent',
      'com.apple.imdpersistence.IMDPersistenceAgent',
      'com.apple.facetimemessagestored',
      'com.apple.telephonyutilities.callservicesd',
    ],
  },
  {
    id: 'connectivity',
    name: 'Sharing & Device Connectivity',
    downside: 'AirDrop, Continuity, CarPlay, Watch, and Find My connectivity will not work.',
    labels: [
      'com.apple.rapportd',
      'com.apple.companiond',
      'com.apple.carkitd',
      'com.apple.wcd',
      'com.apple.tvremoted',
      'com.apple.avatarsd',
      'com.apple.stickersd',
      'com.apple.sociallayerd',
      'com.apple.announced',
      'com.apple.navd',
      'com.apple.findmy.findmylocated',
    ],
  },
  {
    id: 'telemetry',
    name: 'Ads, Diagnostics & Telemetry',
    downside: 'DeviceCheck plus analytics, diagnostics, and feedback services are unavailable.',
    labels: [
      'com.apple.ap.adprivacyd',
      'com.apple.ap.promotedcontentd',
      'com.apple.diagnosticextensionsd',
      'com.apple.feedbackd',
      'com.apple.rtcreportingd',
      'com.apple.securityuploadd',
      'com.apple.geoanalyticsd',
      'com.apple.triald',
      'com.apple.followupd',
      'com.apple.purplebuddy.budd',
      'com.apple.devicecheckd',
    ],
  },
  {
    id: 'mdm',
    name: 'Device Management',
    downside: 'Declarative device management, and MDM or configuration-profile workflows that use it, will not work.',
    labels: ['com.apple.remotemanagementd', 'com.apple.RemoteManagementAgent', 'com.apple.managedassetsd'],
  },
  {
    id: 'other',
    name: 'Other Background Services',
    downside:
      'Wallet, App Clips, accessibility asset downloads, merchant, business, and miscellaneous background services are unavailable.',
    labels: [
      'com.apple.financed',
      'com.apple.passd',
      'com.apple.merchantd',
      'com.apple.coreidvd',
      'com.apple.businessservicesd',
      'com.apple.deviceaccessd',
      'com.apple.replicatord',
      'com.apple.linkd',
      'com.apple.ind',
      'com.apple.storagedatad',
      'com.apple.StatusKitAgent',
      'com.apple.countryd',
      'com.apple.mobileassetd',
      'com.apple.managedconfiguration.passcodenagd',
      'com.apple.accessibility.axassetsd',
      'com.apple.ClipServices.clipserviced',
    ],
  },
];

export const SIM_SLIM_REQUIRED_LABELS: readonly string[] = [
  'com.apple.assistantd',
  'com.apple.gamed',
  'com.apple.sharingd',
];

export const SIM_SLIM_FEATURES: readonly SimSlimFeature[] = [
  { id: 'push', name: 'Push notifications', labels: ['com.apple.apsd'] },
  { id: 'app-store', name: 'App Store', labels: ['com.apple.appstored', 'com.apple.itunesstored'] },
  { id: 'universal-links', name: 'Universal links / associated domains', labels: ['com.apple.swcd'] },
  { id: 'spotlight', name: 'Spotlight & Settings search', labels: ['com.apple.searchd', 'com.apple.searchtoold'] },
  { id: 'files-recents', name: 'Files & document picker Recents', labels: ['com.apple.searchd'] },
  { id: 'siri', name: 'Siri & speech', labels: ['com.apple.assistantd', 'com.apple.corespeechd'] },
  { id: 'icloud', name: 'iCloud sync', labels: ['com.apple.cloudd'] },
  { id: 'keychain-sync', name: 'iCloud Keychain', labels: ['com.apple.akd'] },
  { id: 'contacts', name: 'Contacts', labels: ['com.apple.contactsd'] },
  { id: 'calendar', name: 'Calendar', labels: ['com.apple.calaccessd'] },
  { id: 'reminders', name: 'Reminders', labels: ['com.apple.remindd'] },
  { id: 'mail', name: 'Mail', labels: ['com.apple.email.maild'] },
  { id: 'photos', name: 'Photos library & analysis', labels: ['com.apple.assetsd', 'com.apple.photoanalysisd'] },
  { id: 'health', name: 'HealthKit', labels: ['com.apple.healthd'] },
  { id: 'homekit', name: 'HomeKit', labels: ['com.apple.homed'] },
  { id: 'imessage', name: 'iMessage & FaceTime', labels: ['com.apple.identityservicesd'] },
  {
    id: 'widgets',
    name: 'Widgets & Live Activities',
    labels: ['com.apple.chronod', 'com.apple.liveactivitiesd', 'com.apple.navd'],
  },
  { id: 'wallet', name: 'Wallet & passes', labels: ['com.apple.passd'] },
  { id: 'maps', name: 'Maps background services', labels: ['com.apple.Maps.mapssyncd'] },
  { id: 'weather', name: 'Weather', labels: ['com.apple.weatherd'] },
  { id: 'news', name: 'News', labels: ['com.apple.newsd'] },
  { id: 'game-center', name: 'Game Center', labels: ['com.apple.gamed'] },
  { id: 'find-my', name: 'Find My', labels: ['com.apple.findmy.findmylocated'] },
  {
    id: 'mdm',
    name: 'Declarative device management',
    labels: ['com.apple.remotemanagementd', 'com.apple.RemoteManagementAgent'],
  },
  { id: 'app-clips', name: 'App Clips', labels: ['com.apple.ClipServices.clipserviced'] },
  { id: 'screen-time', name: 'Screen Time', labels: ['com.apple.ScreenTimeAgent'] },
  {
    id: 'storekit',
    name: 'StoreKit / in-app purchase',
    labels: [
      'com.apple.storekitd',
      'com.apple.itunesstored',
      'com.apple.amsaccountsd',
      'com.apple.amsengagementd',
      'com.apple.amsondevicestoraged',
      'com.apple.passd',
      'com.apple.financed',
    ],
  },
];
