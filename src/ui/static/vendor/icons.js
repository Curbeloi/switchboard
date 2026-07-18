// Inline line-icon set (20×20, currentColor) vendored from anomalyco/opencode's
// icon.tsx. Square line caps are the house style. Use OCIcon(name, {size}) to get
// an <svg> string, or put data-ico="name" on an element and it's filled on load.
(function () {
  const I = {
    "layout-left":
      '<path d="M2.91675 2.917L2.41675 2.917L2.41675 17.084L2.91675 17.084L17.0834 17.084L17.5834 17.084L17.5834 2.917L17.0834 2.917L2.91675 2.917ZM3.41675 16.584L3.41675 3.417L7.41674 3.417L7.41674 16.584L3.41675 16.584ZM8.41674 16.584L8.41674 3.417L16.5834 3.417L16.5834 16.584L8.41674 16.584Z" fill="currentColor"/>',
    "layout-right":
      '<path d="M2.91536 2.914H2.36536V17.081H17.632V2.914H2.91536ZM3.46536 16.531V3.464H11.532V16.531H3.46536ZM12.532 16.531V3.464H16.532V16.531H12.532Z" fill="currentColor"/>',
    "settings-gear":
      '<path d="M7.62516 4.46094L5.05225 3.86719L3.86475 5.05469L4.4585 7.6276L2.0835 9.21094V10.7943L4.4585 12.3776L3.86475 14.9505L5.05225 16.138L7.62516 15.5443L9.2085 17.9193H10.7918L12.3752 15.5443L14.9481 16.138L16.1356 14.9505L15.5418 12.3776L17.9168 10.7943V9.21094L15.5418 7.6276L16.1356 5.05469L14.9481 3.86719L12.3752 4.46094L10.7918 2.08594H9.2085L7.62516 4.46094Z" stroke="currentColor"/><path d="M12.5002 10.0026C12.5002 11.3833 11.3809 12.5026 10.0002 12.5026C8.61945 12.5026 7.50016 11.3833 7.50016 10.0026C7.50016 8.62189 8.61945 7.5026 10.0002 7.5026C11.3809 7.5026 12.5002 8.62189 12.5002 10.0026Z" stroke="currentColor"/>',
    "plus-small":
      '<path d="M9.99984 5.41699V14.5837M5.4165 10.0003H14.5832" stroke="currentColor" stroke-linecap="square"/>',
    "close-small": '<path d="M6 6L14 14M14 6L6 14" stroke="currentColor" stroke-linecap="square"/>',
    trash:
      '<path d="M4.16677 4.58008L4.66652 4.54055L5.4585 17.4134H14.5417L15.3337 4.54055L15.8334 4.58008M2.08342 4.45508H17.9167M6.83951 4.35149C7.20002 3.27803 8.2145 2.50586 9.40758 2.50586H10.5925C11.7856 2.50586 12.8001 3.27803 13.1606 4.35149" stroke="currentColor" stroke-linecap="square"/>',
    reset:
      '<path d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10" stroke="currentColor" stroke-linecap="square"/>',
    stop: '<rect x="5" y="5" width="10" height="10" fill="currentColor"/>',
    play: '<path d="M5.41699 3.75L15.417 10L5.41699 16.25V3.75Z" fill="currentColor"/>',
    console:
      '<path d="M3.75 5.4165L8.33333 9.99984L3.75 14.5832M10.4167 14.5832H16.25" stroke="currentColor" stroke-linecap="square"/>',
    terminal:
      '<path d="M6.5 8L8.64286 10L6.5 12M10.9286 12H13.5M2 18H18V2H2V18Z" stroke="currentColor" stroke-linecap="square"/>',
    folder:
      '<path d="M2.08301 2.91675V16.2501H17.9163V5.41675H9.99967L8.33301 2.91675H2.08301Z" stroke="currentColor" stroke-linecap="round"/>',
    "speech-bubble":
      '<path d="M18.3334 10.0003C18.3334 5.57324 15.0927 2.91699 10.0001 2.91699C4.90749 2.91699 1.66675 5.57324 1.66675 10.0003C1.66675 11.1497 2.45578 13.1016 2.5771 13.3949C2.5878 13.4207 2.59839 13.4444 2.60802 13.4706C2.69194 13.6996 3.04282 14.9364 1.66675 16.7684C3.5186 17.6538 5.48526 16.1982 5.48526 16.1982C6.84592 16.9202 8.46491 17.0837 10.0001 17.0837C15.0927 17.0837 18.3334 14.4274 18.3334 10.0003Z" stroke="currentColor" stroke-linecap="square"/>',
    enter:
      '<path d="M5.83333 15.8334L2.5 12.5L5.83333 9.16671M3.33333 12.5H17.9167V4.58337H10" stroke="currentColor" stroke-linecap="square"/>',
    "chevron-down": '<path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square"/>',
    "chevron-right": '<path d="M8 15L13 10L8 5" stroke="currentColor" stroke-linecap="square"/>',
    review:
      '<path d="M7 14.5H13M7 7.99512H10.0049M10.0049 7.99512H13M10.0049 7.99512V5M10.0049 7.99512V11M18 18V2L2 2L2 18H18Z" stroke="currentColor"/>',
    graph:
      '<path d="M6.5 6.7L13.5 6.1M6.2 7.6L9.4 13.2M13.8 7.6L10.6 13.2" stroke="currentColor" stroke-linecap="round"/><circle cx="5" cy="6" r="2.4" fill="currentColor"/><circle cx="15" cy="5.6" r="2.4" fill="currentColor"/><circle cx="10" cy="15" r="2.4" fill="currentColor"/>',
  };

  function OCIcon(name, opts) {
    const o = opts || {};
    const s = o.size || 16;
    const cls = "oc-ico" + (o.class ? " " + o.class : "");
    const inner = I[name] || "";
    return (
      `<svg viewBox="0 0 20 20" width="${s}" height="${s}" fill="none" stroke-width="${o.stroke || 1.25}" ` +
      `class="${cls}" aria-hidden="true" focusable="false">${inner}</svg>`
    );
  }

  // Fill any element carrying data-ico="name" (static markup). Idempotent.
  function apply(root) {
    (root || document).querySelectorAll("[data-ico]").forEach((el) => {
      if (el.dataset.icoDone) return;
      el.insertAdjacentHTML("afterbegin", OCIcon(el.dataset.ico, { size: Number(el.dataset.icoSize) || 16 }));
      el.dataset.icoDone = "1";
    });
  }

  window.OCIcon = OCIcon;
  window.OCApplyIcons = apply;
  if (document.readyState !== "loading") apply();
  else document.addEventListener("DOMContentLoaded", () => apply());
})();
