/* eslint-env es6, browser, node, worker */

// WebWorker that runs the ndt7 upload test
const workerMain = function(ev) {
  const url = ev.data['///ndt/v7/upload'];
  const wt = new WebTransport(url); //(mp): 'net.measurementlab.ndt.v7' is not used in the WebTransport API
  wt.ready.then(() => {
    console.log(wt)
    wt.createUnidirectionalStream().then((sendStream => {
      let now;
      if (typeof performance !== 'undefined' &&
          typeof performance.now === 'function') {
        now = () => performance.now();
      } else {
        now = () => Date.now();
      }
      uploadTest(sendStream, postMessage, now);
    })).catch((error) => {
      console.log(`Couldn't create a unidirectional stream for the upload test du to ${error}.`);
    });
    const receiveUniStreamReader = wt.incomingUnidirectionalStreams.getReader();
    function processUniStream(receiveStreamResult) {
      if (receiveStreamResult.value) {
        streamReader = receiveStreamResult.value.getReader();
        streamReader.read().then((readResult => {
          postMessage({
            MsgType: "measurement",
            ServerMessage: new TextDecoder().decode(readResult.value),
            Source: 'server',
          })
        }));
      }
      if (!receiveStreamResult.done) {
        receiveUniStreamReader.read().then(processUniStream);
      }
    }
    receiveUniStreamReader.read().then(processUniStream);
  });
  wt.closed.then(() => {
    console.log(`The HTTP/3 connection to ${url} closed gracefully.`);
  }).catch((error) => {
    console.log(`The HTTP/3 connection to ${url} closed due to ${error}.`);
  });
};

const uploadTest = function(sendStream, postMessage, now) {
  let closed = false;
  const writer = sendStream.getWriter();

  /*sock.onerror = function(ev) {
    postMessage({
      MsgType: 'error',
      Error: ev.type,
    });
  };*/

  // TODO(mp): We have to stop faking them to get real measurement
  postMessage({
    MsgType: "measurement",
    ServerMessage: '{"ConnectionInfo":{"Client":"[2001:67c:370:128:112b:b20c:bca7:7efc]:34574","Server":"[2001:668:1f:61::203]:443","UUID":"ndt-9jm6m_1667210630_000000000006601C"},"BBRInfo":{"BW":60655,"MinRTT":35762,"PacingGain":739,"CwndGain":739,"ElapsedTime":3036116},"TCPInfo":{"State":1,"CAState":0,"Retransmits":0,"Probes":0,"Backoff":0,"Options":7,"WScale":119,"AppLimited":1,"RTO":500000,"ATO":40000,"SndMSS":1238,"RcvMSS":1238,"Unacked":2,"Sacked":0,"Lost":0,"Retrans":0,"Fackets":0,"LastDataSent":64,"LastAckSent":0,"LastDataRecv":24,"LastAckRecv":84,"PMTU":1500,"RcvSsThresh":259168,"RTT":121633,"RTTVar":66897,"SndSsThresh":2147483647,"SndCwnd":17,"AdvMSS":1428,"Reordering":3,"RcvRTT":88390,"RcvSpace":54472,"TotalRetrans":0,"PacingRate":173345,"MaxPacingRate":-1,"BytesAcked":14753,"BytesReceived":1000000,"SegsOut":220,"SegsIn":406,"NotsentBytes":0,"MinRTT":35762,"DataSegsIn":391,"DataSegsOut":28,"DeliveryRate":60684,"BusyTime":1276000,"RWndLimited":0,"SndBufLimited":0,"Delivered":27,"DeliveredCE":0,"BytesSent":155938,"BytesRetrans":0,"DSackDups":0,"ReordSeen":0,"RcvOooPack":0,"SndWnd":64128,"ElapsedTime":3036116}}',
    Source: 'server',
  })

  // TODO(mp): fix this
  /*sock.onmessage = function(ev) {
    if (typeof ev.data !== 'undefined') {
      postMessage({
        MsgType: 'measurement',
        Source: 'server',
        ServerMessage: ev.data,
      });
    }
  };*/

  /**
   * uploader is the main loop that uploads data in the web browser. It must
   * carefully balance a bunch of factors:
   *   1) message size determines measurement granularity on the client side,
   *   2) the JS event loop can only fire off so many times per second, and
   *   3) websocket buffer tracking seems inconsistent between browsers.
   *
   * Because of (1), we need to have small messages on slow connections, or
   * else this will not accurately measure slow connections. Because of (2), if
   * we use small messages on fast connections, then we will not fill the link.
   * Because of (3), we can't depend on the websocket buffer to "fill up" in a
   * reasonable amount of time.
   *
   * So on fast connections we need a big message size (one the message has
   * been handed off to the browser, it runs on the browser's fast compiled
   * internals) and on slow connections we need a small message. Because this
   * is used as a speed test, we don't know before the test which strategy we
   * will be using, because we don't know the speed before we test it.
   * Therefore, we use a strategy where we grow the message exponentially over
   * time. In an effort to be kind to the memory allocator, we always double
   * the message size instead of growing it by e.g. 1.3x.
   *
   * @param {*} data
   * @param {*} start
   * @param {*} end
   * @param {*} previous
   * @param {*} total
   */
  function uploader(data, start, end, previous, total, bufferedAmount) {
    if (closed) {
      // socket.send() with too much buffering causes socket.close(). We only
      // observed this behaviour with pre-Chromium Edge.
      return;
    }
    const t = now();
    if (t >= end) {
      if (!closed) {
        writer.close()
        sendStream.close()
        closed = true;
        postMessage({
          MsgType: 'complete',
        });
      }
      // send one last measurement.
      postClientMeasurement(total, bufferedAmount, start);  
      return;
    }

    const maxMessageSize = 8388608; /* = (1<<23) = 8MB */
    const clientMeasurementInterval = 250; // ms

    // Message size is doubled after the first 16 messages, and subsequently
    // every 8, up to maxMessageSize.
    const nextSizeIncrement =
        (data.length >= maxMessageSize) ? Infinity : 16 * data.length;
    if ((total - bufferedAmount) >= nextSizeIncrement) {
      data = new Uint8Array(data.length * 2);
    }

    // We keep 7 messages in the send buffer, so there is always some more
    // data to send. The maximum buffer size is 8 * 8MB - 1 byte ~= 64M.
    const desiredBuffer = 7 * data.length;
    if (bufferedAmount < desiredBuffer) {
      // TODO(mp): Write the damn thing
      writer.ready.then(() => {
        writer.write(data).then(() => {
          console.log(data.length);
          total += data.length;
          const t2 = now();
          if (t2 >= previous + clientMeasurementInterval) {
            postClientMeasurement(total, bufferedAmount, start);
            previous = t2;
          }
          setTimeout(() => uploader(data, start, end, previous, total, 0 /*TODO(mp): bufferedAmount?*/), 0);
        });
      })
    } else if (t >= previous + clientMeasurementInterval) {
      postClientMeasurement(total, bufferedAmount, start);
      previous = t;
      // Loop the uploader function in a way that respects the JS event handler.
      setTimeout(() => uploader(data, start, end, previous, total, 0 /*TODO(mp): bufferedAmount?*/), 0);
    }
  }

  /** Report measurement back to the main thread.
   *
   * @param {*} total
   * @param {*} bufferedAmount
   * @param {*} start
   */
  function postClientMeasurement(total, bufferedAmount, start) {
    // bytes sent - bytes buffered = bytes actually sent
    const numBytes = total - bufferedAmount;
    // ms / 1000 = seconds
    const elapsedTime = (now() - start) / 1000;
    // bytes * bits/byte * megabits/bit * 1/seconds = Mbps
    const meanMbps = numBytes * 8 / 1000000 / elapsedTime;
    postMessage({
      MsgType: 'measurement',
      ClientData: {
        ElapsedTime: elapsedTime,
        NumBytes: numBytes,
        MeanClientMbps: meanMbps,
      },
      Source: 'client',
      Test: 'upload',
    });
  }

  const initialMessageSize = 8192; /* (1<<13) = 8kBytes */
  // TODO(bassosimone): fill this message - see above comment
  const data = new Uint8Array(initialMessageSize);
  const start = now(); // ms since epoch
  const duration = 10000; // ms
  const end = start + duration; // ms since epoch

  postMessage({
    MsgType: 'start',
    Data: {
      StartTime: start / 1000, // seconds since epoch
      ExpectedEndTime: end / 1000, // seconds since epoch
    },
  });

  // Start the upload loop.
  uploader(data, start, end, start, 0, 0 /*TODO(mp): bufferedAmount?*/);
};

// Node and browsers get onmessage defined differently.
if (typeof self !== 'undefined') {
  self.onmessage = workerMain;
} else if (typeof this !== 'undefined') {
  this.onmessage = workerMain;
} else if (typeof onmessage !== 'undefined') {
  onmessage = workerMain;
}
