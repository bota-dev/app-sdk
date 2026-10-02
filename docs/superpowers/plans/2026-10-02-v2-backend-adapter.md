# SDK-owned encrypted-v2 backend adapter

The customer should supply an authenticated HTTPS backend base URL, current
account/project/device identity and a fresh-token callback. The React Native
App SDK owns native HTTP, exact-session journaling, manifest submission,
publication polling and receipt delivery. Existing custom native providers stay
supported. No API secret, ciphertext or signed document crosses into JavaScript.

This is an owner-approved change from application-owned v2 HTTP. It is an
optional device-upload adapter for a customer backend exposing the existing v2
routes, not a general API SDK or automatic migration from legacy completion.
The first-party dashboard bridge can supply its existing route prefix.

1. Reuse the native iOS/Android upload adapter in the RN package; remove its Expo
   dependency and add one public managed sync entry. Verify package, Codegen and
   native adapter builds.
2. Keep stable recording/session identity through pending verification and
   reconnect, retain uncertain creation outcomes, cancel on scope invalidation,
   and delete only after signed receipt confirmation. Verify interruption,
   identity, cancellation and publication tests on both native implementations.
3. Document the small customer integration and public-release requirements;
   compare implementation against durable completion/cleanup acceptance before
   claiming readiness. Test evidence does not establish physical qualification.

The host must abort its captured scope when account/project/binding changes;
the SDK does not infer login state. Retry timers require an active application;
reconnect/sync resumes the native journal after process restart. Customer
backends must expose the v2 routes; forwarding legacy upload-complete is not
sufficient. Device v2 capability and deployment gates remain unchanged.
