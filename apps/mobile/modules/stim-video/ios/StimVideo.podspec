Pod::Spec.new do |s|
  s.name           = 'StimVideo'
  s.version        = '1.0.0'
  s.summary        = 'Decodes H.264 device video from stim-server.'
  s.description    = 'A native view that decodes the H.264 frames stim-server streams and shows them.'
  s.author         = ''
  s.homepage       = 'https://github.com/appandflow/stim'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
