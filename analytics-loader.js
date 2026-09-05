/* Load third-party analytics after the page is usable, while preserving queued events. */
(function () {
  'use strict';

  var loaderScript = document.currentScript;
  var requestedPixel = loaderScript && loaderScript.getAttribute('data-meta-pixel-id');
  var metaPixelId = /^\d{8,20}$/.test(requestedPixel || '') ? requestedPixel : '970332989051988';

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', 'G-CV7HJ2QGHX');
  window.gtag('config', 'AW-18102284288');

  if (!window.fbq) {
    var fbq = window.fbq = function () {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
    };
    window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = false;
    fbq.version = '2.0';
    fbq.queue = [];
  }
  window.fbq('init', metaPixelId);
  window.fbq('track', 'PageView');

  var started = false;
  var wakeEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'];

  function addScript(src) {
    var script = document.createElement('script');
    script.async = true;
    script.src = src;
    document.head.appendChild(script);
  }

  function startAnalytics() {
    if (started) return;
    started = true;
    wakeEvents.forEach(function (eventName) {
      window.removeEventListener(eventName, startAnalytics);
    });
    addScript('https://www.googletagmanager.com/gtag/js?id=G-CV7HJ2QGHX');
    addScript('https://connect.facebook.net/en_US/fbevents.js');
    addScript('https://www.clarity.ms/tag/wf7ba129jm');
  }

  wakeEvents.forEach(function (eventName) {
    window.addEventListener(eventName, startAnalytics, { once: true, passive: true });
  });
  window.addEventListener('load', function () {
    // Keep analytics out of the first render without losing most short visits.
    window.setTimeout(startAnalytics, 2500);
  }, { once: true });
}());
