/*jslint
  single, white, browser, multivar, long
*/
/*global
  Snap, joint, $, WebSocket
*/
$(document).ready(function() {                                                            // make sure the document is ready for DOM manipulation
  'use strict';
  var
    wsRelative              = function wsRelative(relativePath) {                         // get the relative path for the websocket URIs
      return window.location.href.replace(/^http/, 'ws')+relativePath.slice(1);           // replace the http with ws (works for https/wss)
    },
    socket                  = new WebSocket(wsRelative('/control-plane')),                // our control panel web socket
    g                       = new joint.dia.Graph(),                                      // the main element for JointJS
    paper                   = new joint.dia.Paper({                                       // the main paper for JointJS
      el          : $('#jointctlpanel'),                                                  // the element
      width       : '100%',                                                               // elastic width
      height      : 'auto',                                                               // relative height
      model       : g,                                                                    // connection the model to the paper
      gridSize    : 1
    }),
    tweetRedisIntersections = {},                                                         // start empty objects to organize the control panel elements...
    tweetLinks              = {},
    linkStatus              = {},
    animations              = {},                                                         // ...end
    standardDuration        = 5000,                                                       // animation duration
    strokeOffset0           = { strokeDashoffset : 0 },                                   // DRY animation start
    strokeOffset1000        = { strokeDashoffset : 1000 },                                // DRY animation end
    disconnected            = true,                                                       // start disconnected
    eater,                                                                                // start empty variables for elements on the page...
    twitter,
    cloud,
    search,
    graph,
    server,
    browser,
    cloudRedisLink,
    searchRedisLink,
    graphRedisLink,
    twitterEaterLink,
    cloudServerLink,
    searchServerLink,
    graphServerLink,
    graphQueryLink,
    searchQueryLink,
    unionServerLink,
    broswerServerLink,
    unionIntersection;                                                                    // ... end

  function getLinkUnique(link) {                                                          // we need to quickly identify unique links so we have this simple helper
    return [link.attributes.source.id, link.attributes.target.id].join('-');
  }

  function snapLinkAlter(link,status, attrsStart, attrsEnd, duration) {                   // abstract how we alter the link (status)
    var
      linkId = getLinkUnique(link),                                                       // get the link id (start/end)
      q = 'g[model-id="'+link.id+'"] .connection',                                        // the DOM selector
      snapLink = Snap.select(q),                                                          // get it with Snap
      aniRepeat;                                                                          // define the function we'll use later

    if (status === true) {                                                                // we want to animate
      aniRepeat = function() {                                                            // define the animation function
        snapLink.attr(attrsStart);                                                        // the starting position
        snapLink.animate(                                                                 // Snap's animate - originally we used CSS animation but the GPU load was too crazy
          attrsEnd,                                                                       // our end posiiton
          duration,                                                                       // duration of the animation
          aniRepeat                                                                       // self call for a looped animation
        );
      };
      aniRepeat();                                                                        // start the animation
    } else {
      snapLink.stop();                                                                    // stop the animation
    }
    linkStatus[linkId] = status;                                                          // set the link status for this pair

    link.attr({ '.connection' : { 'data-active'  : linkStatus[linkId] ? 1 : 0 } });       // set the attribute in the DOM (for CSS styling)
  }

  function boxStatus(box, onOrOff) {                                                      // abstract the status
    box.attr({ rect : { 'data-enabled' : onOrOff  } });                                   // set the attribute in the DOM (for CSS styling)
  }
  
  function disconnect() {                                                                 // on socket disconnect, make the UI evident of this disconnection
    var 
      links = [                                                                           // all the links that we need to "dim"
        cloudServerLink,cloudRedisLink,searchQueryLink,searchRedisLink,
        searchServerLink,graphServerLink,graphRedisLink,graphQueryLink,
        unionServerLink,twitterEaterLink,tweetLinks.eaterCloud,
        tweetLinks.cloudSearch,tweetLinks.searchGraph,broswerServerLink],
      boxes = [
        twitter,eater,search,cloud,graph,server,browser                                   // all the boxes we need to "dim"
      ];
    links.forEach((aLink) => snapLinkAlter(aLink,false));                                 // alter the links 
    boxes.forEach((aBox) => boxStatus(aBox,'disconnect'));                                // alter the boxes
  }

  function box(id, text,  x, y, opts) {                                                   // abstract the JointJS boxes
    if (!opts) {                                                                          // options object is optional
      opts = {};
    }
    return new joint.shapes.basic.Rect({                                                  // create the box as a rectangle
      id  : id,                                                                           // pass in relevant arguments
      position : { x : x, y : y},                                                         // pass in relevant arguments
      size: { width: 150, height: 35 },                                                   // standard size
      attrs: { 
        rect: { 
          fill: opts.backgroundColor || '#B62411',                                        // overrideable colour
          rx : 5,                                                                         // box rounding
          ry : 10,                                                                        // box rounding
          stroke : opts.backgroundBorder || '#6d150a',                                    // overrideable colour
          'stroke-width' : 2,                                                             // sandard width
          'data-enabled' : opts.dataEnabled || 'yes'                                      // this will end up being a way to style
        },                    
        text: {                                                                           // styled text - easier to do in JS for SVG for demo purposes
          text: text , 
          'font-family' : "'Lato', sans-serif" , 
          'font-weight' : 900, 
          fill: 'white', 
          'font-variant': 'small-caps' 
        } 
      }
    });
  }
  function intersection(position) {                                                       // create an stream intersection point
    return new joint.shapes.basic.Circle({                                                // circle primiative
      position  : position,                                                               // passed position
      size  : { width: 10, height: 10 },                                                  // standard size
      attrs : {
        circle  : { stroke  : '#7F7F7F', 'stroke-width' : 2 }                             // standard outline
      }
    });
  }
  function link(source,target, opts, attrsStart, attrsEnd, duration) {                    // create a link between two boxes (or intersections)
    opts = opts || {};                                                                    // optional 
    var attrs = {                                                                         // definiable colour and standard width
          '.connection' : { stroke  : opts.color || '#7F7F7F', 'stroke-width' : 3 } 
      },
      theLink;
    if (opts.special) {                                                                   // this allows for more css styling
      attrs['.connection']['data-special'] = opts.special;
    }   
    theLink = new joint.dia.Link({                                                        // create the JointJS link between boxes/intersections
        source  : { id : source.id },                                                     // with the defined attributes and source/target
        target  : { id : target.id },
        attrs   : attrs
      });
    
    animations[getLinkUnique(theLink)] = {                                                // pass in the animations for this particular unique link
      attrsStart  : attrsStart,
      attrsEnd    : attrsEnd,
      duration    : duration
    };
    return theLink;                                                                       // chaining
  }


  function toggleUnion() {                                                                // the union of all the streams has some special visual logic
    var 
      linkId = getLinkUnique(unionServerLink),                                            // get the link for the small link between the output union and the server            
      linkAnimations = animations[linkId];                                                // and the related animations
    // the union will be active if any of the feeding links are active
    if (linkStatus[getLinkUnique(cloudServerLink)] || linkStatus[getLinkUnique(searchServerLink)] || linkStatus[getLinkUnique(graphServerLink)]) {
      snapLinkAlter(unionServerLink,true, linkAnimations.attrsStart,linkAnimations.attrsEnd,linkAnimations.duration);
    } else {
      snapLinkAlter(unionServerLink, false, linkAnimations.attrsStart,linkAnimations.attrsEnd,linkAnimations.duration);
    }
  }


  eater       = box('eater','twitter api eater', 200, 30);                                // eater box 
  twitter     = box('twitter', 'twiitter api', 0, 30, {                                   // twitter box
    backgroundColor : '#1da1f2',                                                          // gets twitter brand colours
    backgroundBorder : '#33aaf3'
  });
                                                                                          // these are all aligned
  cloud       = box('cloud','word count',350, 175-14);                                    // cloud box
  search      = box('search','search',350, 100-14);                                       // search box
  graph       = box('graph','graph',350, 250-14);                                         // graph box

  server      = box('server','server', 800 , 175-14, {                                    // server box
    backgroundColor : '#6cc24a',                                                          // gets node.js colours
    backgroundBorder : '#44883e' 
  });
  browser     = box('browser','browser', 800, 325-14, {                                   // browser
    backgroundColor : '#6e008b',                                                          // is purple to differentiate 
    backgroundBorder : '#460058' 
  });

  boxStatus(cloud,'off');                                                                 // all engine boxes start in off state (which is not automatically true, but ok for this simplistic version)
  boxStatus(graph,'off');
  boxStatus(search,'off');

  paper.svg.setAttribute('preserveAspectRatio','xMidYMid meet');                          // SVG scaling with the window
  paper.svg.setAttribute('viewBox','0 0 1000 400');                                       // virtual coordinates
  socket.onopen = function () {                                                           // when the websocket opens...
    var linkAnimations = animations[getLinkUnique(broswerServerLink)];                    // the link between the browser and server
    snapLinkAlter(                                                                        // change the animation... 
      broswerServerLink,                                                                  // ...for the browser/server link
      true,                                                                               // ...to the active state
      linkAnimations.attrsStart,                                                          // with the defined animation and duration
      linkAnimations.attrsEnd,
      linkAnimations.duration
    );
    disconnected = false;                                                                 // let the rest of the script know we're active
  };
  socket.onclose = function() {                                                           // when the socket is closed
    snapLinkAlter(broswerServerLink,false);                                               // deactivate the browser/server link
    disconnected = true;                                                                  // let the rest of the script know we're inactive
    disconnect();                                                                         // disconnect visual stauts
  };

  tweetRedisIntersections.search = intersection({ x : 270, y : 100 });                    // create the search intersection 
  tweetLinks.cloudSearch = link(                                                          // link the intersection from... 
    eater,                                                                                // ...the eater...
    tweetRedisIntersections.search,                                                       // ...to the search intersection
    {},                                                                                   // nothing optional
    strokeOffset1000,                                                                     // with the standard animation and duration
    strokeOffset0, 
    standardDuration
  ); 

  tweetRedisIntersections.cloud = intersection({ x : 270, y : 175 });                     // create the cloud intersection
  tweetLinks.eaterCloud = link(                                                           // link the intersection from...
    tweetRedisIntersections.search,                                                       // ...search...
    tweetRedisIntersections.cloud,                                                        // ...to cloud
    {},                                                                                   // nothing optional
    strokeOffset1000,                                                                     // with the standard animation and duration
    strokeOffset0, 
    standardDuration
  );

  tweetRedisIntersections.graph = intersection({ x : 270, y : 250 });                     // create the graph intersection
  tweetLinks.searchGraph = link(                                                          // link the intersection from...
    tweetRedisIntersections.cloud,                                                        // ...cloud...
    tweetRedisIntersections.graph,                                                        // ...to graph
    {},                                                                                   // nothing optional
    strokeOffset1000,                                                                     // with the standard animation and duration
    strokeOffset0, 
    standardDuration
  );

  unionIntersection = intersection({ x : 650, y : 175});                                  // the "special" union intersection


  // create the various links (inputs and output) streams
  cloudRedisLink    = link(tweetRedisIntersections.cloud, cloud, {}, strokeOffset1000, strokeOffset0, standardDuration);
  searchRedisLink   = link(tweetRedisIntersections.search, search, {}, strokeOffset1000, strokeOffset0, standardDuration);
  graphRedisLink    = link(tweetRedisIntersections.graph, graph, {}, strokeOffset1000, strokeOffset0, standardDuration);
  twitterEaterLink  = link(twitter,eater, { special : 'twitter' },  strokeOffset1000, strokeOffset0, standardDuration);
  cloudServerLink   = link(cloud,unionIntersection, {}, strokeOffset1000, strokeOffset0, standardDuration);
  searchServerLink  = link(search,unionIntersection, {}, strokeOffset1000, strokeOffset0, standardDuration);
  graphServerLink   = link(graph,unionIntersection, {}, strokeOffset1000, strokeOffset0, standardDuration);
  graphQueryLink    = link(server,graph, {}, strokeOffset1000, strokeOffset0, standardDuration);
  searchQueryLink   = link(server,search, {}, strokeOffset1000, strokeOffset0, standardDuration);
  unionServerLink   = link(unionIntersection,server, {}, strokeOffset1000, strokeOffset0, standardDuration);
  broswerServerLink = link(server,browser, {}, strokeOffset1000, strokeOffset0, standardDuration);

  broswerServerLink.attr({ '.connection' : { 'data-constant-active'  : 1 } });          // the browser link gets a special animation
  //linkAlter(broswerServerLink,false);

  // add all the elements onto the host
  g.addCells([
    twitter, 
    eater,
    twitterEaterLink,
    tweetRedisIntersections.cloud,
    tweetRedisIntersections.search,
    tweetRedisIntersections.graph,
    tweetLinks.eaterCloud,
    cloud,
    cloudRedisLink,
    browser,

    search,
    searchRedisLink,


    tweetLinks.cloudSearch,
    tweetLinks.searchGraph,
    graph,
    graphRedisLink,

    unionIntersection,
    server,
    cloudServerLink,
    searchServerLink,
    graphServerLink,
    graphQueryLink,
    searchQueryLink,
    unionServerLink,
    broswerServerLink
  ]);

  snapLinkAlter(broswerServerLink, false);                                                // browser starts as false (will change at connect)



  function toggleLink(link) {                                                             // toggle a link active/inactive
    var 
      linkId = getLinkUnique(link),
      linkAnimations = animations[linkId];
    snapLinkAlter(link,!linkStatus[linkId],linkAnimations.attrsStart,linkAnimations.attrsEnd,linkAnimations.duration);

    return linkStatus[linkId];
  }


  g.on('batch:start', function(ev) {                                                      // there isn't a "click" event per say, but this works
    var
      twitterStatus,
      status;
    if (!disconnected) {                                                                  // if we're active
      if (ev.cell && ev.cell.id === eater.id) {                                           // check if we have a cell in the event and that the id is for the eater
        toggleLink(tweetLinks.eaterCloud);                                                // if we don't have a eater events, then we just turn off the branches on the left
        toggleLink(tweetLinks.cloudSearch);
        toggleLink(tweetLinks.searchGraph);
        twitterStatus = toggleLink(twitterEaterLink) ? 'on' : 'off';                      // the toggle output after toggling
        if (twitterStatus === 'off') {                                                    // we can't just toggle everything, unfortuately
          socket.send(JSON.stringify({ fn : 'cloud', 'status' : 'off' }));                // turn off word cloud
          snapLinkAlter(cloudServerLink,false);                                           // stop the dependent links asl well
          snapLinkAlter(cloudRedisLink,false);
  
          socket.send(JSON.stringify({ fn : 'search', 'status' : 'off' }));               // turn off search indexing       
          snapLinkAlter(searchQueryLink,false);                                           // turn off the query pathway
          snapLinkAlter(searchRedisLink,false);                                           // turn off the connection to the server
          snapLinkAlter(searchServerLink,false);                                          // turn off the response path
  
         
          socket.send(JSON.stringify({ fn : 'graph', 'status' : 'off' }));                // turn off graph [indexing] visualization
          snapLinkAlter(graphServerLink,false);                                           // turn off the query pathway
          snapLinkAlter(graphRedisLink,false);                                            // turn off the connection to the server
          snapLinkAlter(graphQueryLink,false);                                            // turn off the response path
  
          boxStatus(cloud,'off');                                                         // turn off the boxes in the paths
          boxStatus(graph,'off');
          boxStatus(search,'off');
  
          toggleUnion();                                                                  // visual logic for the union
        }
        socket.send(JSON.stringify({ fn : 'eater', 'status' : twitterStatus }));          // tell the server to stop eating tweets
        
      } else if (
        (ev.cell && ev.cell.id === cloud.id) &&                                           // we've got a cell in the event and the id is for word cloud
        linkStatus[getLinkUnique(twitterEaterLink)]                                       // the linkStatus is set
      ){
        status = toggleLink(cloudServerLink) ? 'on' : 'off';                              // determine if we're going on or off
        toggleLink(cloudRedisLink);                                                       // toggle the link between the word cloud and redis
        toggleUnion();                                                                    // visual logic for the union
        boxStatus(cloud,status);                                                          // turn the box on/off
  
        socket.send(JSON.stringify({ fn : 'cloud', 'status' : status }));                 // tell the server about counting words
      } else if (
        (ev.cell && ev.cell.id === search.id) &&                                          // we've got a cell and the ID = search
        linkStatus[getLinkUnique(twitterEaterLink)]                                       // the linkStatus is set for this link
      ) {
        status = toggleLink(searchServerLink) ? 'on' : 'off';                             // are we going off or on?
        toggleLink(searchRedisLink);                                                      // toggle the server/search link
        toggleLink(searchQueryLink);                                                      // toggle the search/query link
        toggleUnion();                                                                    // visual logic for the union
        boxStatus(search,status);                                                         // turn the box on/off
        socket.send(JSON.stringify({ fn : 'search', 'status' : status }));                // tell the server about indexing search
      } else if (
        (ev.cell && ev.cell.id === graph.id) &&                                           // we've got a cell and ID is for graph
        linkStatus[getLinkUnique(twitterEaterLink)]                                       // the linkStatus is set for this link
      ) {
        status = toggleLink(graphServerLink) ? 'on' : 'off';                              // are we going off or on?
        toggleLink(graphRedisLink);                                                       // toggle the server/graph link
        toggleLink(graphQueryLink);                                                       // toggle the graph/query link
        toggleUnion();                                                                    // visual logic for the union
        boxStatus(graph,status);                                                          // turn the box on/off
        socket.send(JSON.stringify({ fn : 'graph', 'status' : status }));                 // tell the server about indexing query
      } 
    }
  });
});
