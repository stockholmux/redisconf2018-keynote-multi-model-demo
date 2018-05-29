/*jslint
  node, multivar, white, single, this
*/
const
  async         = require('async');                                                       // `async` provides a endless async loop and a parallel async fire

// we're passing everything in here - this allows for more flexibility in this module
module.exports = function streamProcessor(client,streams,elementProcessors,errorCb) {   // export a stream processing function
  "use strict";
  let 
    last = {};                                                                            // internally keep our last seen sequences
  streams.forEach(function(aStreamName) { last[aStreamName] = '$'; } );                   // initialize it to the $ which is shorthand for 'give me the most recent'
                                                                                          // note that this setup will not keep this state between restarts of these processes.
                                                                                          // If you wanted to make it fully resilient, you would store this is Redis or some other data store
  async.forever(                                                                          // repeat forever
    function(done) {                                                                      // done says we're done processing
      let xreadArgs = [].concat(                                                          // we need to push the arguments in as an array since we don't know which or how many
        [5000,'STREAMS'],                                                                 // restart listening after 5000 ms (5 seconds), and then start listing streams
        streams,                                                                          // an array of streams
        Object.values(last)                                                               // an their last seen values - note that we're relying on Object.values returning the order correctly...
      );                                                                                  // ...but it could cause problems. Will revise in next version.

      client.xread(                                                                       // Read from the streams
        'BLOCK',                                                                          // in a BLOCKing fashion - e.g. block the redis client until we get data. This isn't in the array because of quirk in how node_redis sees commands - usually the first command is always the key
        xreadArgs,                                                                        // the rest of the arguments.
        function(err,data) {                                                              // error first callback
          if (err) { done(err); } else {                                                  // handle the error
            if (data) {                                                                   // no error and we've got some data...
              let toProcess = [];                                                         // the streams output an array element per stream
              data.forEach(function(aStream) {                                            // deal with each
                let 
                  streamName = aStream[0],                                                // stream name will be in the 0th position
                  streamElements = aStream[1],                                            // the events/messages will be nested in the 1st position
                  processor = elementProcessors[streamName];                              // our element processor is passed in from the object in the original fn

                streamElements.forEach(function(anElement) {                              // iterate through the steam elements
                  last[streamName] = anElement[0];                                        // update the last seen object with the current sequence
                  toProcess.push(processor(anElement));                                   // push our element and processing function into an array
                });
              });

              async.parallel(toProcess,done);                                             // run them all without waterafall (parallel-ish)

            } else {
              done(null);                                                                 // no data? ok - just return back with no error.
            }
          }
        }
      );
    },
    function(err) {                                                                       // this should only happen if there is an error
      if (errorCb && err) {                                                               // we've passed in an error handling function and a non-null error exists
        errorCb(err);                                                                     // handle the error
      } else if (err) { throw err; }                                                      // otherwise, throw.
    }
  );
};
