/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

(function() {
  'use strict';

  let tagZones = new Map();
  let tagZoneStack = [];
  let callbackZoneStack = []
  let originalRegisterElement = document.registerElement;
  window._elementTagZones = tagZones;

  let _statNames = ['register', 'created', 'attached', 'detached',
      'attributeChanged', 'data'];

  function forkStatsZone(parentZone, zoneStack, name) {
    if (parentZone._childZones && parentZone._childZones[name]) {
      return parentZone._childZones[name];
    }
    parentZone._childZones = parentZone._childZones || {};
    let statsZone = parentZone.fork({
      'beforeTask': function () {
        // console.log('beforeTask', this.$id, this.tagName, this.name, this);

        if (zoneStack.length > 0) {
          // we're already in a zone, so pause its timers
          let oldZone = zoneStack[zoneStack.length - 1];
          let stats = oldZone.stats;
          let startTime = stats.startTime;
          if (startTime > 0) {
            let taskTime = performance.now() - startTime;
            // console.log(`time for ${this.$id} ${oldZone.tagName} += ${taskTime}`);
            stats.totalTime += taskTime;
            stats.startTime = 0;
          }
        }

        this.stats.startTime = performance.now();
        zoneStack.push(this);
      },

      'afterTask': function () {
        // console.log('afterTask', this.$id, this.tagName, this.name, this);
        let currentZone = zoneStack.pop();
        console.assert(currentZone === this, currentZone, this);

        let stats = this.stats;
        let taskTime = performance.now() - stats.startTime;
        stats.totalTime += taskTime;
        // console.log(`time for ${this.$id} ${this.tagName} ${this.name} += ${taskTime}`);
        stats.startTime = 0;

        if (zoneStack.length > 0) {
          // restart the timer on the old zone
          let oldZone = zoneStack[zoneStack.length - 1];
          oldZone.stats.startTime = performance.now();
        }
      },
    });
    parentZone._childZones[name] = statsZone;
    // console.log('resetting startTime (fork)', statsZone.$id);
    statsZone.stats = {
      totalTime: 0,
      startTime: 0,
    };
    if (name) {
      parentZone.stats[name] = statsZone.stats;
      statsZone.name = name;
    }
    return statsZone;
  }

  function getTagZone(tagName) {
    if (tagZones.has(tagName)) {
      return tagZones.get(tagName);
    }
    console.log('creating new zone for', tagName);
    // create a Zone to cover all tasks for element
    let tagZone = forkStatsZone(zone, tagZoneStack);
    tagZone.stats.tagName = tagZone.tagName = tagName;
    tagZone.stats.count = 0;
    tagZones.set(tagName, tagZone);
    return tagZone;
  }

  document.registerElement = function(tagName, options) {
    let clazz = options;
    let tagZone = getTagZone(tagName);
    let proto = options.prototype;
    let originalCreate = options.prototype.createdCallback;
    if (proto.createdCallback) {
      proto.createdCallback =
          forkStatsZone(tagZone, callbackZoneStack, 'created').bind(function() {
        tagZone.stats.count++;
        originalCreate.call(this);
      });
    }
    if (proto.attachedCallback) {
      proto.attachedCallback =
          forkStatsZone(tagZone, callbackZoneStack, 'attached').bind(proto.attachedCallback);
    }
    if (proto.detachedCallback) {
      proto.detachedCallback =
          forkStatsZone(tagZone, callbackZoneStack, 'detached').bind(proto.detachedCallback);
    }
    if (proto.attributeChangedCallback) {
      proto.attributeChangedCallback =
          forkStatsZone(tagZone, callbackZoneStack, 'attributeChanged').bind(proto.attributeChangedCallback);
    }

    if (proto._propertySetter || proto.notifyPath) {
      let dataZone = forkStatsZone(tagZone, callbackZoneStack, 'data');
      if (proto._propertySetter) {
        proto._propertySetter = dataZone.bind(proto._propertySetter);
      }
      if (proto.notifyPath) {
        proto.notifyPath = dataZone.bind(proto.notifyPath);
      }
    }

    // Running document.registerElement in the tagZone will cause zone.js
    // to bind all callbacks to tagZone
    let registerZone = forkStatsZone(tagZone, callbackZoneStack, 'register');
    if (zone === registerZone) {
      return originalRegisterElement(tagName, options);
    } else {
      return registerZone.run(function() {
        return originalRegisterElement(tagName, options);
      });
    }
  }

  function clearStats() {
    for (let tagName of Array.from(tagZones.keys())) {
      let tagZone = tagZones.get(tagName);
      let stats = tagZone.stats;
      stats.count = 0;
      stats.totalTime = 0;
      stats.startTime = 0;
      for (let stat of _statNames) {
        if (stats[stat]) {
          let s = stats[stat];
          s.totalTime = 0;
          s.startTime = 0;
        }
      }
    }
  }

  function gatherStats() {
    let data = {};
    tagZones.forEach(function(v, k) {
      data[k] = v.stats;
    });
    return data;
  }

  //
  // Polymer-specific patching
  //

  var _Polymer;
  var _PolymerCalled = false;
  var _PolymerWrapper = function() {
    if (!_PolymerCalled) {
      _PolymerCalled = true;

      // patch Polymer.Async.run
      if (_PolymerWrapper.Async && _PolymerWrapper.Async.run) {
        let originalRun = _PolymerWrapper.Async.run;
        _PolymerWrapper.Async.run = function(callback, waitTime) {
          if (window.zone && !(waitTime > 0)) {
            callback = window.zone.bind(callback);
          }
          return originalRun.call(this, callback, waitTime);
        }
      }

      // patch Polymer.RenderStatus.whenReady
      if (_PolymerWrapper.RenderStatus && _PolymerWrapper.RenderStatus.whenReady) {
        let originalWhenReady = _PolymerWrapper.RenderStatus.whenReady;
        _PolymerWrapper.RenderStatus.whenReady = function(cb) {
          if (window.zone && window.zone.bind) {
            cb = window.zone.bind(cb);
          }
          return originalWhenReady.call(this, cb);
        };
      }
    }
    let tagName = arguments[0] && arguments[0].is;
    if (tagName) {
      console.log('running Polymer() in a zone for', tagName);
      let tagZone = getTagZone(tagName);
      return forkStatsZone(tagZone, callbackZoneStack, 'register').run(() => {
        return _Polymer.apply(this, arguments);
      });
    } else {
      console.log('running Polymer() outside a zone');
      return _Polymer.apply(this, arguments);
    }
  };

  // replace window.Polymer with accessors so we can wrap calls to Polymer()
  Object.defineProperty(window, 'Polymer', {
    set: function(p) {
      if (p !== _PolymerWrapper) {
        _Polymer = p;
      }
    },
    get: function() {
      return (typeof _Polymer === 'function') ? _PolymerWrapper : _Polymer;
    },
  });

  // Listen for requests for timing data
  window.addEventListener('message', function(event) {
    if (event.data.messageType && (
          event.data.messageType === 'get-element-stats' ||
          event.data.messageType === 'clear-element-stats')) {
      if (event.data.messageType === 'clear-element-stats') {
        clearStats();
      }
      event.source.postMessage({
        messageType: 'element-stats',
        data: gatherStats(),
      }, '*');
    }
  });

  window._printElementStats = function() {
    for (let tagName of Array.from(tagZones.keys())) {
      let tagZone = tagZones.get(tagName);
      let stats = tagZone.stats;
      let calcedTotal =
        stats.register.totalTime +
        stats.created.totalTime;
      if (stats.attached) {
        calcedTotal += stats.attached.totalTime;
      }
      if (stats.detached) {
        calcedTotal += stats.detached.totalTime;
      }
      if (stats.attributeChanged) {
        calcedTotal += stats.attributeChanged.totalTime;
      }
      let data = {
        totalTime: stats.totalTime.toFixed(3),
        calcedTotal: calcedTotal.toFixed(3),
        register: stats.register.totalTime.toFixed(3),
        created: stats.created.totalTime.toFixed(3),
        attached: stats.attached && stats.attached.totalTime.toFixed(3),
        detached: stats.detached && stats.detached.totalTime.toFixed(3),
        attributeChanged: stats.attributeChanged && stats.attributeChanged.totalTime.toFixed(3),
        data: stats.data && stats.data.totalTime.toFixed(3),
      };
      console.log(tagName, data);
    }
  }
})();
