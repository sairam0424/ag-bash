"use strict";

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(listener);
    return this;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  emit(event, ...args) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      // Create a copy to avoid issues if listeners are removed during emission
      const listenersCopy = [...listeners];
      for (const listener of listenersCopy) {
        listener(...args);
      }
      return true;
    }
    return false;
  }

  once(event, listener) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    wrapper.listener = listener;
    return this.on(event, wrapper);
  }

  off(event, listener) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      const index = listeners.findIndex(
        (l) => l === listener || l.listener === listener,
      );
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
    return this;
  }

  removeListener(event, listener) {
    return this.off(event, listener);
  }

  removeAllListeners(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }
}

module.exports = { EventEmitter };
