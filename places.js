// Nearby-places search via the Places API (New), loaded client-side through
// google.maps.importLibrary — no backend server required.
window.Places = (() => {
  async function searchNearby(query, { lat, lng }) {
    const { Place } = await google.maps.importLibrary("places");

    const request = {
      textQuery: query,
      fields: [
        "displayName",
        "formattedAddress",
        "addressComponents",
        "nationalPhoneNumber",
        "location",
        "rating",
        "userRatingCount",
        "currentOpeningHours",
        "businessStatus",
      ],
      locationBias: {
        center: { lat, lng },
        radius: 15000, // 15km
      },
      rankPreference: "DISTANCE",
      maxResultCount: 5,
    };

    const { places } = await Place.searchByText(request);

    const withDistance = places
      .filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY")
      .map((p) => ({
        name: p.displayName,
        address: p.formattedAddress,
        area: extractArea(p.addressComponents),
        phoneNumber: p.nationalPhoneNumber ?? null,
        rating: p.rating ?? null,
        ratingCount: p.userRatingCount ?? 0,
        openNow: p.currentOpeningHours?.openNow ?? null,
        distanceKm: haversineKm(lat, lng, p.location.lat(), p.location.lng()),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return withDistance.slice(0, 3);
  }

  function extractArea(addressComponents) {
    if (!addressComponents) return null;
    const byType = (type) =>
      addressComponents.find((c) => c.types?.includes(type));
    const component =
      byType("sublocality") ?? byType("neighborhood") ?? byType("locality");
    return component?.longText ?? component?.shortText ?? null;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  return { searchNearby };
})();
