(() => {
  const body = document.body;
  const showLabel =
    body?.dataset?.showPasswordLabel || 'Show password';
  const hideLabel =
    body?.dataset?.hidePasswordLabel || 'Hide password';

  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.closest('.password-input-wrap')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'password-input-wrap';

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';
    button.setAttribute('aria-label', showLabel);
    button.setAttribute('title', showLabel);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>' +
      '<circle cx="12" cy="12" r="2.5"></circle>' +
      '</svg>';

    wrapper.appendChild(button);

    button.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';

      const label = showing ? showLabel : hideLabel;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.classList.toggle('is-showing', !showing);
    });
  });
})();
