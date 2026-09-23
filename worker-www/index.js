/* Send www to the apex, permanently.
 *
 * www.rastu.tech served a complete copy of all 133 pages. Google crawled both,
 * honoured the canonical on the duplicate, and reported it back as "alternate
 * page with proper canonical tag". The report is harmless; the waste is not.
 * On a site this new the crawl budget is small, and half of it was going to a
 * copy that can never be indexed while most of the RFC pages had not been
 * fetched at all.
 *
 * This is its own Worker rather than a branch in the main one because static
 * assets are matched before that Worker runs. Making it run first would put
 * every page view on the metered path to fix a problem that only affects
 * crawlers and mistyped addresses.
 */
export default {
  fetch(request) {
    // Scheme and host are both corrected in one hop. Turning on Always Use
    // HTTPS at the zone made http://www take two: once to https on www, then
    // again to the apex. Each hop loses a little of what a redirect passes on,
    // and the crawler has to make two requests to learn one thing.
    const url = new URL(request.url);
    url.hostname = "rastu.tech";
    url.protocol = "https:";
    // 301 rather than 302: this is not temporary, and only a permanent redirect
    // consolidates the ranking signals onto the apex.
    return Response.redirect(url.toString(), 301);
  },
};
