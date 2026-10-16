(() => {
  if (!('serviceWorker' in navigator)) return;

  const installButton = document.getElementById('pwa-install-button');
  const banner = document.getElementById('pwa-install-banner');
  const bannerInstall = document.getElementById('pwa-banner-install');
  const bannerLater = document.getElementById('pwa-banner-later');
  const bannerText = document.getElementById('pwa-install-text');

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    document.documentElement.classList.add('pwa-standalone');
  }

  navigator.serviceWorker.register('/service-worker.js', {
    scope: '/admin/'
  }).catch((error) => {
    console.warn('Solidus PWA service worker registration failed:', error);
  });

  if (isStandalone) return;

  let deferredPrompt = null;
  const isIos =
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) &&
    !window.MSStream;

  const dismissedRecently = () => {
    try {
      const dismissedAt = Number(
        localStorage.getItem('solidusPwaInstallDismissedAt') || 0
      );

      return dismissedAt > 0 &&
        Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000;
    } catch (error) {
      return false;
    }
  };

  const hideBanner = () => {
    if (banner) banner.hidden = true;
  };

  const showInstallEntry = () => {
    if (installButton) installButton.hidden = false;

    if (banner && !dismissedRecently()) {
      window.setTimeout(() => {
        banner.hidden = false;
      }, 900);
    }
  };

  const showIosInstructions = () => {
    if (bannerText && bannerText.dataset.iosText) {
      bannerText.textContent = bannerText.dataset.iosText;
    }

    if (bannerInstall) {
      bannerInstall.hidden = true;
    }

    if (banner) {
      banner.hidden = false;
    }
  };

  const requestInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();

      try {
        const choice = await deferredPrompt.userChoice;

        if (choice.outcome === 'accepted') {
          hideBanner();
          if (installButton) installButton.hidden = true;
        }
      } finally {
        deferredPrompt = null;
      }

      return;
    }

    if (isIos) {
      showIosInstructions();
    }
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    showInstallEntry();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideBanner();
    if (installButton) installButton.hidden = true;

    try {
      localStorage.removeItem('solidusPwaInstallDismissedAt');
    } catch (error) {
      // Ignore storage restrictions.
    }
  });

  installButton?.addEventListener('click', requestInstall);
  bannerInstall?.addEventListener('click', requestInstall);

  bannerLater?.addEventListener('click', () => {
    hideBanner();

    try {
      localStorage.setItem(
        'solidusPwaInstallDismissedAt',
        String(Date.now())
      );
    } catch (error) {
      // Ignore storage restrictions.
    }
  });

  if (isIos) {
    showInstallEntry();
  }
})();
