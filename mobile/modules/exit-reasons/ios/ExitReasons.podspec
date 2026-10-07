Pod::Spec.new do |s|
  s.name           = 'ExitReasons'
  s.version        = '1.0.0'
  s.summary        = 'Why the operating system closed the app, for the error log.'
  s.description    = 'Reads MetricKit exit counts and diagnostics so the app can report them on its next launch.'
  s.license        = 'UNLICENSED'
  s.author         = 'TexasRenters'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'MetricKit'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = "**/*.{h,m,swift}"
end
