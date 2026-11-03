/* The Vault Standoff service worker. SOLE purpose: Web Push. It handles a 'push' event (showing an OS notification
   even when the tab is closed / backgrounded / on mobile) and a 'notificationclick' event (focus an open game tab,
   else open the game). It touches NO funds, NO escrow, NO keys. It is served from the app root so it resolves at
   BOTH /pub/main/vault-standoff/sw.js (dashboard) and /sw.js (custom domain standoff.vaultrobbers.com); the client
   registers it with a RELATIVE scope ('sw.js', {scope:'./'}) so it adapts to whichever origin is serving it. */

// Activate immediately so a freshly-registered worker can receive pushes without waiting for a reload.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

// PUSH: the server sends a JSON payload { title, body, tag, url }. We render it via the Notification API from the SW,
// which is the ONLY way a notification shows on a closed/backgrounded tab or on mobile. Everything is defensive: a
// malformed/absent payload still shows a sensible default rather than throwing (a throw here would drop the push).
self.addEventListener('push', function(event){
  var data = {};
  try { if (event.data) data = event.data.json(); } catch (e) { try { data = { body: event.data && event.data.text() }; } catch (_) { data = {}; } }
  var title = (data && data.title) || 'The Vault Standoff';
  var opts = {
    body: (data && data.body) || 'A new heist is forming.',
    tag: (data && data.tag) || 'vs-push',          // collapse repeats of the same event into one notification
    icon: (data && data.icon) || 'apple-touch-icon.png',   // relative to the SW scope -> resolves on both origins
    badge: (data && data.badge) || 'apple-touch-icon.png',
    renotify: false,
    data: { url: (data && data.url) || './' }       // where notificationclick should land
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// CLICK: focus an already-open game tab if one exists (any client under this scope), else open a new one at the
// notification's url. Uses the SW registration scope so it works on both the dashboard path and the custom domain.
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        // Any window under our scope counts as "the game is open" -> focus it rather than spawn a duplicate tab.
        if (c.url && 'focus' in c) { try { return c.focus(); } catch (e) {} }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
