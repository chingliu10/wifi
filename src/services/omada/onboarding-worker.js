const { syncClaimsOnce } = require('./provisioning-service');

let timer = null;
let running = false;

const tick = async () => {
  if (running) return;

  running = true;

  try {
    await syncClaimsOnce();
  } catch (error) {
    console.error('OMADA ONBOARDING WORKER ERROR:', error.message);
  } finally {
    running = false;
  }
};

const startOmadaOnboardingWorker = () => {
  if (
    String(process.env.OMADA_API_ENABLED || '').toLowerCase() !== 'true' ||
    timer
  ) {
    return;
  }

  const intervalMs = Math.max(
    10000,
    Number(process.env.OMADA_ONBOARDING_POLL_MS || 15000)
  );

  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();

  console.log(`Omada onboarding worker started (${intervalMs}ms)`);
};

module.exports = {
  startOmadaOnboardingWorker
};
