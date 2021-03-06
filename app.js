#!/usr/bin/env node

const http = require('http')
const geolib = require('geolib')
const fetch = require('node-fetch')
const polyline = require('@mapbox/polyline')
const osrmTextInstructions = require('osrm-text-instructions')('v5')

const baseUrl = process.env.OSRM_BACKEND || 'http://localhost:5000'
const port = process.env.PORT || 3000
const intersectionDist = 100
const alternatives = 5;
const stripAlternative = false

http.createServer(onRequest).listen(parseInt(port))

/**
 * Catch all incoming request in order to translate them.
 * @param {Object} clientReq
 * @param {Object} clientRes
 */
async function onRequest(clientReq, clientRes) {
  let osrmPath = translatePath(clientReq.url)
  let result = await fetch(`${baseUrl}${osrmPath}`).then(res => res.json())

  console.log(`Path ${clientReq.url} translated to ${osrmPath}`)

  let translatedResult = translateResult(result)
  let destination = getDestination(clientReq.url)
  let origin = getOrigin(clientReq.url);
  let intersections = fetchIntersections(result.routes[0], alternatives)
  translatedResult.routes[0] = fetchInstructions(result.routes[0])

  clientRes.write(JSON.stringify(translatedResult))
  clientRes.end('\n')
}

/**
 * Make sure that the directions endpoint is mapped to the routing endpoint.
 * Strip all GET params and append some needed params.
 * @param {String} originalPath
 * @return {String} translatedPath
 */
function translatePath(originalPath) {
  return originalPath.replace('directions/v5/mapbox', 'route/v1')
    .split('?')[0] +
    '?steps=true&annotations=true&overview=full&continue_straight=true'
}

/**
 * Return an array of every intersection along the route
 * @param {Object} route
 * @return {Array} intersections
 */
function fetchIntersections(route, limit) {
  let intersections = []
  let count = 0
  let duration = 0
  for (let leg of route.legs) {
    for (let step of leg.steps) {
      duration += step.duration
      for (let intersection of step.intersections) {
        intersection.duration = duration
        intersections.push(intersection)
        count++
        if (count >= limit) {
          return intersections
        }
      }
    }
  }
  return intersections
}

/**
 * Add text instructions to OSRM steps
 * @param {Object} route
 * @return {Object} route
 */
function fetchInstructions(route) {
  route.legs.map(leg => {
    for (let i = 0; i < leg.steps.length; i++) {
      leg.steps[i].maneuver.instruction = ''
      if (typeof leg.steps[i + 1] === 'undefined') {
        return
      }
      leg.steps[i].voiceInstructions = [{
        distanceAlongGeometry: leg.steps[i].distance,
        announcement: osrmTextInstructions.compile('en', leg.steps[i + 1]),
        ssmlAnnouncement: '<speak><amazon:effect name="drc"><prosody rate="1.08">' +
          osrmTextInstructions.compile('en', leg.steps[i + 1]) +
          '</prosody></amazon:effect></speak>'
      }]
      leg.steps[i].bannerInstructions = [{
        distanceAlongGeometry: leg.steps[i].distance,
        primary: {
          text: osrmTextInstructions.getWayName('en', leg.steps[i + 1]),
          components: [{
            text: osrmTextInstructions.compile('en', leg.steps[i + 1]),
            type: 'text'
          }],
          type: leg.steps[i + 1].maneuver.type,
          modifier: leg.steps[i + 1].maneuver.modifier,
          degrees: leg.steps[i + 1].maneuver.bearing_after,
          driving_side: leg.steps[i + 1].driving_side
        },
        secondary: null
      }]
    }
    return leg
  })
  return route
}

/**
 * Return true if the route contains a cycle
 * @param {Object} route
 * @param {Array} waypoints
 * @param {Geopoint} origin
 */
function hasCycle(route, waypoints, origin) {

  // Checks if there are U-turns with waypoints distance ; Could do it with the
  // intersection distance but seems complicated
  if (waypoints.length !== 0) {
    let distanceCounter = 0;
    for (let waypoint of waypoints) {
      if (waypoint.distance) {
        if (waypoint.distance > distanceCounter)
          distanceCounter = waypoint.distance;
        if (waypoint.distance < distanceCounter)
          return true;
      }
    }
  }

  let intersections = {};
  for (let [legIndex, leg] of route.legs.entries()) {
    for (let [stepIndex, step] of leg.steps.entries()) {
      for (let [intersectionIndex, intersection] of step.intersections
        .entries()) {

        // If intersection not far from origin and it isn't the first one of the
        // first step of the first....
        if ((intersectionIndex !== 0 && stepIndex !== 0 && legIndex !== 0) &&
          !checkDistance(toGeopoint("" + intersection.location[0] + "," +
              intersection.location[1] + ""),
            origin, 25 / 1000)) // Distance in km
          return true;

        intersections[toGeostring(intersection.location)] =
          intersections[toGeostring(intersection.location)] + 1 || 0
        if (intersections[toGeostring(intersection.location)] > 1) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Get the destination by parsing the url in url format.
 * @param {String} url
 * @return {Geopoint} destination
 */
function getDestination(url) {
  return toGeopoint(url.split('/')[5].split(';')[1].split('?')[0])
}

/**
 * Check the distance between two points
 * @param {Geopoint} firstGeo
 * @param {Geopoint} secondGeo
 * @param {number} distance
 */
// Check
// https://stackoverflow.com/questions/27928/calculate-distance-between-two-latitude-longitude-points-haversine-formula
// Haversine formula

function checkDistance(firstGeo, secondGeo, distance) {
  let p = 0.017453292519943295; // Math.PI / 180
  let c = Math.cos;
  let a = 0.5 - c((secondGeo.lat - firstGeo.lat) * p) / 2 +
    c(firstGeo.lat * p) * c(secondGeo.lat * p) *
    (1 - c((secondGeo.lon - firstGeo.lon) * p)) / 2;

  let calculatedDistance =
    12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
  return calculatedDistance > distance
}

/**
 * Get the origin by parsing the url in url format.
 * @param {String} url
 * @return {Geopoint} origin
 */
function getOrigin(url) {
  return toGeopoint(url.split('/')[5].split(';')[0])
}

/**
 * The mapbox sdk needs a uuid, crashes otherwise. So append one here.
 * @param {Object} originalResult
 * @return {Object} translatedResult
 */
function translateResult(originalResult) {
  let translatedResult = Object.assign({}, originalResult)
  translatedResult.uuid = 1
  translatedResult.routes.forEach(
    route => route.legs.forEach(leg => delete leg.annotation))
  return translatedResult
}

/**
 * Calculate the points around the intersection.
 * These points are intersectionDist meters away from the intersection
 * on every unused road.
 * @param {Object} intersection
 * @return {Array} viaPoints
 */
function getViaPoints(intersection) {
  let initialPoint = toGeopoint(intersection.location)
  let otherBearings = intersection.bearings
  let bearingIn = otherBearings[intersection.in]
  let bearingOut =
    otherBearings[intersection.out]

  // Remove bearings of current primary route and the ones ones in wrong
  // direction
  otherBearings = otherBearings.filter(bearing => bearing !== bearingOut &&
    bearing !== bearingIn)

  var viaPoints =
    otherBearings.map(bearing => {
      return geolib.computeDestinationPoint(
        initialPoint, intersectionDist, bearing)
    })
  return viaPoints
}

/**
 * Get alternative routes via every viapoint from the intersection.
 * @param {Object} intersection
 * @param {Geopoint} destination
 * @return {Promise[]|routes} alternative routes
 */
function getAlternativeRoutes(intersection, destination) {
  return new Promise((resolve, reject) => {
    let start = toGeopoint(intersection.location)
    let viaPoints = getViaPoints(intersection)
    let alternativeRoutes = viaPoints.map(
      viaPoint => {
        return getRoute([start, viaPoint, destination])
      })

    Promise.all(alternativeRoutes).then(routes => {
      let sortedRoutes = routes.sort((a, b) => {
        return a.routes[0].duration > b.routes[0].duration ? 1 : -1
      })
      sortedRoutes.map(route => {
        route.routes[0].duration = route.routes[0].duration + intersection.duration
        return route
      })
      resolve(sortedRoutes)
    })
  })
}

/**
 * Fetch an alternative route from OSRM service.
 * @param {Array} points
 * @return {Promse|Route}
 */
function getRoute(waypoints) {
  let coordinates = toCoordinateString(waypoints)
  return fetch(`${baseUrl}/route/v1/driving/${coordinates}?steps=true`)
    .then(res => res.json())
}

/**
 * Determine color of route based on extra time
 * @param {Object} alternativeRoute
 * @param {Object} originalRoute
 */
function getColor(alternativeRoute, originalRoute) {
  let extraTime = alternativeRoute.duration - originalRoute.duration
  let extraPercentage = alternativeRoute.duration / originalRoute.duration

  if (extraTime < 100 || extraPercentage < 1.05) {
    return 'moderate'
  } else {
    return 'heavy'
  }
}

/**
 * Only keep the first two steps of the route.
 * @param {Object} alternativeRoute
 * @return {Object} alternativeRoute
 */
function stripAlternativeRoute(alternativeRoute) {
  alternativeRoute.geometry = polyline.encode(
    polyline.decode(alternativeRoute.legs[0].steps[0].geometry)
    .concat(polyline.decode(alternativeRoute.legs[0].steps[1].geometry)))
  return alternativeRoute
}

/**
 * Convert geopoints to the format OSRM understands
 * @param {Array} waypoints
 * @return {String} coordinate string
 */
function toCoordinateString(waypoints) {
  return waypoints
    .map(waypoint => {
      if (waypoint.longitude) {
        waypoint.lon = waypoint.longitude
        waypoint.lat = waypoint.latitude
      }
      return `${waypoint.lon},${waypoint.lat}`
    })
    .join(';')
}

/**
 * Simple "hash" of waypoint
 * @param {Array} waypoint
 * @return {String} waypoint
 */
function toGeostring(waypoint) {
  return `${waypoint[0]};${waypoint[1]}`
}

/**
 * Convert coordinate string or array to the generic geopoint format.
 * @param {String} coordinateString
 * @return {Geopoint} geopoint
 */
function toGeopoint(waypoint) {
  let coordinates =
    (typeof waypoint === 'string') ? waypoint.split(',') : waypoint
  return {
    lon: coordinates[0],
    lat: coordinates[1]
  }
}
