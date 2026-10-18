/* The demo's own page logic: the match filters. Delegated on document, so it keeps working after voice-pilot swaps the page in place. */
(function () {
  "use strict";
  function apply() {
    var list = document.querySelector(".matches");
    if (!list) return;
    var sel = document.querySelector("[data-filter-sector]");
    var sector = sel ? sel.value : "";
    var on = document.querySelector("[data-filter-min][aria-pressed='true']");
    var min = on ? +on.getAttribute("data-filter-min") : 0;
    var n = 0;
    list.querySelectorAll(".match").forEach(function (li) {
      var show = (!sector || li.getAttribute("data-sector") === sector) && +li.getAttribute("data-score") >= min;
      li.hidden = !show;
      if (show) n += 1;
    });
    var c = document.querySelector("[data-match-count]");
    if (c) c.textContent = n + (n === 1 ? " match" : " matches") + (sector ? " in " + sector : "") + (min ? " at " + min + " or more" : "");
  }
  document.addEventListener("change", function (e) { if (e.target.matches && e.target.matches("[data-filter-sector]")) apply(); });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-filter-min]");
    if (!b) return;
    document.querySelectorAll("[data-filter-min]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    apply();
  });
})();
