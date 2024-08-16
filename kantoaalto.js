"use strict";

(function () {
  /*
   * Kantoaallon tilakoodit.
   */
  const TILA = {
    alustettu: 1,
    yhdistetty: 2,
    katkennut: 3,
    virhe: 4
  };

  /*
   * Virhekoodit eri Websocket-katkaisutilanteissa.
   */
  const VIRHE = {
    1002: "Protocol error",
    1003: "Unsupported data",
    1007: "Invalid frame payload data",
    1008: "Policy violation",
    1009: "Message too big",
    1010: "Mandatory extension",
    1015: "TLS handshake"
  };

  /*
   * Promise-alaluokka, joka mahdollistaa `resolve`- tai `reject`-kutsun
   * alkuperäisen sitoumuskoodin ulkopuolelta.
   */
  function Sitoumus () {
    let resolve, reject, promise = new Promise((_resolve, _reject) => {
      resolve = _resolve, reject = _reject
    })
    return Object.assign(promise, {resolve, reject});
  }

  /*
   * Asynkroninen lipputoteutus.
   *
   * Lippu + Jono: vrt. https://stackoverflow.com/a/50398038
   */
  function Lippu (koko) {
    this.koko = koko;
    this._jono = [];
  }
  Object.assign(Lippu.prototype, {
    nosta: function () {
      this.koko++;
      this._jono.pop()?.();
    },
    laske: function () {
      let tulos = Promise.resolve();
      if (! this.koko || this._jono.length > 0)
        tulos = new Promise(function (resolve) {
          this._jono.unshift(resolve);
        }.bind(this));
      this.koko--;
      return tulos;
    }
  });

  /*
   * Asynkroninen jonototeutus.
   */
  function Jono (koko) {
    this.koko = koko;
    this._odottaaSaapuvaa = new Lippu(0);
    this._odottaaLahtevaa = new Lippu(koko);
    this._jono = [];
  }
  Object.assign(Jono.prototype, {
    saapuva: function (alkio) {
      return new Promise(function (resolve) {
        this._odottaaLahtevaa.laske().then(function () {
          this._jono.unshift(alkio);
          this._odottaaSaapuvaa.nosta();
          resolve();
        }.bind(this));
      }.bind(this));
    },
    lahteva: function () {
      return new Promise(function (resolve) {
        this._odottaaLahtevaa.nosta();
        this._odottaaSaapuvaa.laske().then(function () {
          resolve(this._jono.pop());
        }.bind(this));
      }.bind(this));
    }
  });

  /*
   * Katkaisun kestävä, `Promise`-pohjainen toteutus Websocket-datayhteyden
   * käsittelyyn.
   *
   * Parametrit:
   * - url: WS-yhteysosoite, oletuksena nykyinen sivu (location.pathname)
   * - parametrit: yhteyden yksityiskohdat; ks. alempana.
   */
  function Kantoaalto (url, parametrit) {
    this.url = url ?? location.pathname;
    this.parametrit = Object.assign({
      // Viive millisekunneissa, jolla eri tyyppisissä WS-katkaisutilanteissa
      // yritetään yhdistää uudelleen.
      // Viive kaksinkertaistuu jokaisen epäonnistuneen yrityksen jälkeen,
      // kunnes yhteys muodostetaan jälleen onnistuneesti.
      yhdistaUudelleen: {
        1001: 2000,  // "Going Away" (palvelin tai selain päätti yhteyden).
        1006: 500,   // "Abnormal Closure"
        1012: 500,   // "Service Restart"
        1013: 1000,  // "Try Again Later"
        1014: 500,   // "Bad Gateway"
      },

      // Puskuroitavien, saapuneiden viestien enimmäismäärä.
      jono: 10,

      // Kättelydata, joka lähetetään palvelimelle yhdistämisen jälkeen.
      kattelydata: null,

      // Funktio, joka toimittaa tarvittavan kättelyn palvelimen kanssa.
      kattely: function (websocket) {
        if (this.kattelydata)
          websocket.send(this.kattelydata);
      }
    }, parametrit);
    this.tila = TILA.alustettu;

    this._epaonnistunutYhdistaminen = 0;
    this._yhteydenMuodostus = Sitoumus();
    this._yhteysvirhe = Sitoumus();
    this._yhteydenKatkaisu = Sitoumus();

    this._vastaanotto = new Jono(10);

    // Sitoumus _yhteysvirhe täyttyy, kun _yhteydenMuodostus hylätään
    // (ensimmäisen kerran).
    this._yhteydenMuodostus.catch(
      this._yhteysvirhe.resolve.bind(this._yhteysvirhe)
    );

    // Avataan yhteys heti, kun mahdollista.
    this._avaaYhteys();
  }

  Object.assign(Kantoaalto.prototype, {
    /*
     * Avataan yhteys annettuun osoitteeseen.
     */
    _avaaYhteys: function () {
      this._websocket = new WebSocket(this.url);
      Object.assign(this._websocket, {
        onopen: this._onopen.bind(this),
        onclose: this._onclose.bind(this),
        onerror: this._onerror.bind(this),
        onmessage: this._onmessage.bind(this)
      });
    },

    /*
     * Websocket-protokollan mukaiset toteutukset.
     */
    _onopen: function (e) {
      this.tila = TILA.yhdistetty;
      this._epaonnistunutYhdistaminen = 0;
      this.parametrit.kattely(this._websocket);
      this._yhteydenMuodostus.resolve([e, this._websocket]);
      this._yhteydenKatkaisu = Sitoumus();
    },
    _onclose: function (e) {
      let yhdistaUudelleen = this.parametrit.yhdistaUudelleen[[e.code]];
      let virhe = VIRHE[[e.code]];
      this.tila = TILA.katkennut;
      this._yhteydenMuodostus = Sitoumus()
      this._yhteydenMuodostus.catch(
        this._yhteysvirhe.resolve.bind(this._yhteysvirhe)
      );
      if (yhdistaUudelleen) {
        window.setTimeout(
          this._avaaYhteys.bind(this),
          yhdistaUudelleen * (++this._epaonnistunutYhdistaminen)
        );
      }
      else if (e.code > 1000)
        this._yhteydenMuodostus.reject([e, virhe, e.reason]);
      this._yhteydenKatkaisu.resolve(e);
    },
    _onerror: function (e) {
      this.tila = TILA.virhe;
      this._yhteydenKatkaisu.resolve(e);
      this._yhteydenMuodostus.reject([e]);
    },
    _onmessage: function (e) {
      this._vastaanotto.saapuva(e.data);
    },

    /*
     * Lähetetään annettu data, kun yhteys on avoinna.
     */
    laheta: function (data) {
      return this.then(function () {
        this._websocket.send(data);
      }.bind(this));
    },
    /*
     * Palautetaan sitoumus, joka täyttyy saapuvalla datalla.
     */
    vastaanota: function () {
      return this._vastaanotto.lahteva();
    },

    /*
     * Palauttaa sitoumuksen, joka täyttyy seuraavan onnistuneen
     * Websocket-yhteyden muodostamisen jälkeen.
     */
    then: function () {
      return this._yhteydenMuodostus.then(...arguments);
    },
    /*
     * Palauttaa sitoumuksen, joka täyttyy (ensimmäisen) Websocket-
     * yhteyden muodostamiseen liittyvän virhetilanteen jälkeen.
     *
     * Huomaa, että yhteyttä ei muodosteta automaattisesti uudelleen
     * virhetilanteen jälkeen.
     */
    catch: function () {
      return this._yhteysvirhe.then(...arguments);
    },

    /*
     * Palauttaa sitoumuksen, joka täyttyy, kun Websocket-yhteyden
     * muodostamista on yritetty seuraavan kerran.
     */
    finally: function () {
      return this._yhteydenMuodostus.finally(...arguments);
    },

    /*
     * Palauttaa sitoumuksen, joka täyttyy, kun Websocket-yhteys
     * katkeaa seuraavan kerran.
     */
    katkaistu: function () {
      return this._yhteydenKatkaisu;
    },

    /*
     * Sulje (avoin) Websocket-yhteys annetulla koodilla (oletus 1000).
     */
    sulje: function (koodi) {
      return this.then(function () {
        this._websocket.close(koodi ?? 1000)
      }.bind(this));
    }
  });

  /*
   * Tarjotaan globaaliin nimiavaruuteen:
   * - Kantoaalto
   * - Kantoaalto.TILA
   * - Kantoaalto.VIRHE
   * - Kantoaalto.Jono
   * - Kantoaalto.Lippu
   * - Kantoaalto.Sitoumus.
   */

  window.Kantoaalto = Object.assign(
    Kantoaalto,
    {VIRHE, TILA, Jono, Lippu, Sitoumus}
  );
})();
