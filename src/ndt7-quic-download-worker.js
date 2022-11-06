/* eslint-env browser, node, worker */
let complete = false;

// workerMain is the WebWorker function that runs the ndt7 download test.
const workerMain = function(ev) {
  'use strict';
  const url = ev.data['///ndt/v7/download'];
  const wt = new WebTransport(url); //(mp): 'net.measurementlab.ndt.v7' is not used in the WebTransport API
  const receiveUniStreamReader = wt.incomingUnidirectionalStreams.getReader();
  
  receiveUniStreamReader.read().then((receiveStreamResult => {
    let now;
    if (typeof performance !== 'undefined' &&
        typeof performance.now === 'function') {
      now = () => performance.now();
    } else {
      now = () => Date.now();
    }
    console.log("A uni stream has been received");
    downloadTest(receiveStreamResult.value, postMessage, now);
  }));
  wt.closed.then(() => {
    console.log(`The HTTP/3 connection to ${url} closed gracefully.`);
    endMeasurement();
  }).catch((error) => {
    console.log(`The HTTP/3 connection to ${url} closed due to ${error}.`);
    endMeasurement();
  });
};

function endMeasurement() {
  if (!complete) {
    // (mp): Fake a server measurement for now
    postMessage({
      MsgType: "measurement",
      ServerMessage: '{"ConnectionInfo":{"Client":"[2001:67c:370:128:112b:b20c:bca7:7efc]:34574","Server":"[2001:668:1f:61::203]:443","UUID":"ndt-9jm6m_1667210630_000000000006601C"},"BBRInfo":{"BW":60655,"MinRTT":35762,"PacingGain":739,"CwndGain":739,"ElapsedTime":3036116},"TCPInfo":{"State":1,"CAState":0,"Retransmits":0,"Probes":0,"Backoff":0,"Options":7,"WScale":119,"AppLimited":1,"RTO":500000,"ATO":40000,"SndMSS":1238,"RcvMSS":1238,"Unacked":2,"Sacked":0,"Lost":0,"Retrans":0,"Fackets":0,"LastDataSent":64,"LastAckSent":0,"LastDataRecv":24,"LastAckRecv":84,"PMTU":1500,"RcvSsThresh":259168,"RTT":121633,"RTTVar":66897,"SndSsThresh":2147483647,"SndCwnd":17,"AdvMSS":1428,"Reordering":3,"RcvRTT":88390,"RcvSpace":54472,"TotalRetrans":0,"PacingRate":173345,"MaxPacingRate":-1,"BytesAcked":14753,"BytesReceived":481921,"SegsOut":220,"SegsIn":406,"NotsentBytes":0,"MinRTT":35762,"DataSegsIn":391,"DataSegsOut":28,"DeliveryRate":60684,"BusyTime":1276000,"RWndLimited":0,"SndBufLimited":0,"Delivered":27,"DeliveredCE":0,"BytesSent":15938,"BytesRetrans":0,"DSackDups":0,"ReordSeen":0,"RcvOooPack":0,"SndWnd":64128,"ElapsedTime":3036116}}',
      Source: 'server',
    })
    postMessage({
      MsgType: 'complete',
    });
    complete = true;
  }
}

/**
 * downloadTest is a function that runs an ndt7 download test using the
 * passed-in stream instance and the passed-in callback function.  The
 * ??? and callback are passed in to enable testing and mocking.
 *
 * @param {ReadableStream} stream - The WebSocket being read.
 * @param {function} postMessage - A function for messages to the main thread.
 * @param {function} now - A function returning a time in milliseconds.
 */
const downloadTest = function(stream, postMessage, now) {
  let start = now();
  let previous = start;
  let total = 0;
  const streamReader = stream.getReader();

  // TODO(mp): I'm not sure this is the best place for the following
  start = now();
  previous = start;
  total = 0;
  postMessage({
    MsgType: 'start',
    Data: {
      ClientStartTime: start,
    },
  });

  function readChunk() {
    streamReader.read().then((readResult => {
      // TODO(mp): the value could be a string or a byte array? I don't think WebTransport supports this kind of typing
      //total += (typeof ev.data.size !== 'undefined') ? ev.data.size : ev.data.length;
      if (readResult.value !== undefined) {
        total += readResult.value.length;
      }
      // Perform a client-side measurement 4 times per second.
      const t = now();
      const every = 250; // ms
      if (t - previous > every || readResult.done) {
        postMessage({
          MsgType: 'measurement',
          ClientData: {
            ElapsedTime: (t - start) / 1000, // seconds
            NumBytes: total,
            // MeanClientMbps is calculated via the logic:
            //  (bytes) * (bits / byte) * (megabits / bit) = Megabits
            //  (Megabits) * (1/milliseconds) * (milliseconds / second) = Mbps
            // Collect the conversion constants, we find it is 8*1000/1000000
            // When we simplify we get: 8*1000/1000000 = .008
            MeanClientMbps: (total / (t - start)) * 0.008,
          },
          Source: 'client',
        });
        previous = t;
      }

      // TODO(mp): Handle the following, also, what is this?
      // Pass along every server-side measurement.
      /*if (typeof ev.data === 'string') {
        postMessage({
          MsgType: 'measurement',
          ServerMessage: ev.data,
          Source: 'server',
        });
      }*/
      if (!readResult.done) { 
        readChunk();
      } else {
        endMeasurement();
      }
    }));
  };

  streamReader.closed.then(endMeasurement).catch(endMeasurement);
  readChunk();
};

// Node and browsers get onmessage defined differently.
if (typeof self !== 'undefined') {
  self.onmessage = workerMain;
} else if (typeof this !== 'undefined') {
  this.onmessage = workerMain;
} else if (typeof onmessage !== 'undefined') {
  onmessage = workerMain;
}
