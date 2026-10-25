/* Load visit measurement asynchronously; defer optional marketing and replay libraries. */
(function () {
  'use strict';

  // Preview and localhost sessions must not enter the production reports.
  if (!/^(?:www\.)?easygaragecleaning\.com$/.test(window.location.hostname)) return;

  // Repeated script insertion must not send another page view or load vendors twice.
  if (window.__egcAnalyticsQueued) return;
  window.__egcAnalyticsQueued = true;

  var loaderScript = document.currentScript;
  var requestedPixel = loaderScript && loaderScript.getAttribute('data-meta-pixel-id');
  var metaPixelId = /^\d{8,20}$/.test(requestedPixel || '') ? requestedPixel : '970332989051988';

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', 'G-CV7HJ2QGHX');
  window.gtag('config', 'AW-18102284288');
  // Google Tag Manager container (GTM-WXTBD8HG): its start event queues now, gtm.js loads with the rest.
  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

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

  // Clarity's tag expects its command queue to exist before it evaluates.
  window.clarity = window.clarity || function () {
    (window.clarity.q = window.clarity.q || []).push(arguments);
  };

  var started = false;
  var wakeEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'];

  function addScript(src) {
    var script = document.createElement('script');
    script.async = true;
    script.src = src;
    document.head.appendChild(script);
  }

  // This file is deferred. Start GA as soon as the HTML is parsed, without
  // waiting for images, window.load, a timer, or the visitor's first action.
  addScript('https://www.googletagmanager.com/gtag/js?id=G-CV7HJ2QGHX');

  function startAnalytics() {
    if (started) return;
    started = true;
    wakeEvents.forEach(function (eventName) {
      window.removeEventListener(eventName, startAnalytics);
    });
    addScript('https://www.googletagmanager.com/gtm.js?id=GTM-WXTBD8HG');
    addScript('https://connect.facebook.net/en_US/fbevents.js');
    addScript('https://www.clarity.ms/tag/wf7ba129jm');
  }

  wakeEvents.forEach(function (eventName) {
    window.addEventListener(eventName, startAnalytics, { once: true, passive: true });
  });
  function scheduleAnalytics() {
    // Keep analytics out of the first render without losing most short visits.
    window.setTimeout(startAnalytics, 2500);
  }
  if (document.readyState === 'complete') scheduleAnalytics();
  else window.addEventListener('load', scheduleAnalytics, { once: true });
}());
