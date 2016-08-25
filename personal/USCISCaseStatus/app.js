/*
* @Author: Luis Perez
* @Date:   2016-08-24 16:12:46
* @Last Modified by:   Luis Perez
* @Last Modified time: 2016-08-25 11:14:00
*/

'use strict';

var _ = require('lodash')
  , async = require('async')
  , assert = require('assert')
  , debug = require("debug")("USCIS:app")
  , htmlparser = require("htmlparser")
  , request = require('request')
  , select = require("soupselect").select;

var argv = require('yargs')
  .usage("Usage $0 -p IOE -n 0900677923 -t 1 -l 10")
  .help('h')
  .describe("p", "The prefix used for the case numbers.")
  .describe("n", "The case number from which to start the search.")
  .describe("t", "The total number of cases to query.")
  .describe("l", "The total number of request to make at once.")
  .demand(["p", "n"])
  .number("n")
  .number("t")
  .number("l")
  .default({
    p: "IOE",
    n: "0900677923",
    t: 1,
    l: 10
  })
  .alias("p", "prefix")
  .alias("n", "case-number")
  .alias("t", "total")
  .alias("l", "limit")
  .alias("h", "help")
  .argv;

var Const = {
  url: "https://egov.uscis.gov/casestatus/mycasestatus.do",
  method: "POST",
  formDataDefaults: {
    changeLocal: null,
    completedActionsCurrentPage: 0,
    upcomingActionsCurrentPage: 0,
    caseStatusSearchBtn: "CHECK STATUS"
  },
  selectors: {
    main: "div.rows",
    type: "h1",
    text: "p"
  },
  caseNumLength: 10
};

var titleToType = {
  "Biometrics Appointment Was Scheduled": "BIO",
  "Case Was Received and A Receipt Notice Was Emailed": "NOTICE",
  "Decision Notice Mailed": "APPROVED",
  "Request for Additional Evidence Was Mailed": "EVIDENCE_REQUEST",
  "Card Was Delivered To Me By The Post Office": "CARD_DELIVERED",
  "Interview Was Scheduled": "INTERVIEW"
};

var utils = {
  pad: function(num, size) {
    var s = num + "";
    while (s.length < size) {
      s = "0" + s;
    }
    return s;
  },

  extract: function(dom, selector){
    var data = select(dom, selector);
    assert(data.length === 1, true, "too many of " + selector);
    data = data[0].children;
    if(data){
      assert(data.length > 0, true, "no children of " + selector);
      return data[0].data;
    }
    return null;
  },

  infoParser: function(text, title) {
    function getType(key){
      if (_.has(titleToType, key)){
        return titleToType[key];
      }
      else{
        console.log("unknown key", key);
        return "UNKNOWN"
      }
    };

    function getDate(data){
      try{
        var seperated = data.split(",");
        var dateString = seperated.slice(0,2).join(", ");
        dateString = dateString.slice(3, dateString.length);
        return new Date(dateString);
      } catch(e){
        console.log("error parsing date", e);
        return Date.now();
      }
    };

    return {
      data: {
        raw: text,
        heading: title
      },
      type: getType(title),
      date: getDate(text)
    }
  },

  /**
   * Extracts the information for each case from the raw HTML retrieved.
   * @param  {String} [rawHTML] - Raw HTML of the page.
   */
  extractInfo: function(rawHTML, callback){
    var handler = new htmlparser.DefaultHandler(function(err, dom){
      if(err){
        console.log("error parsing page");
        return callback(err);
      }

      var titleSelector = [Const.selectors.main, Const.selectors.type].join(" ");
      var textSelector = [Const.selectors.main, Const.selectors.text].join(" ");
      var title = utils.extract(dom, titleSelector);
      var text = utils.extract(dom, textSelector);
      if(!title || !text){
        return callback({
          msg: "info extraction failed"
        });
      }
      return callback(null, utils.infoParser(text, title));
    });

    var parser = new htmlparser.Parser(handler);
    parser.parseComplete(rawHTML);
  },

  /**
   * Retrieves an object of information pertinent to the specified case.
   * @param  {String} [case] - The case number, in string format, to be used to check the USCIS site.
   */
  retrieveCaseStatus: function(caseNum, callback){
    var formData = _.extend({}, Const.formDataDefaults, {
      appReceiptNum: caseNum
    });
    request.post({
      rejectUnauthorized: false,
      url: Const.url,
      form: formData,
      headers: {
        UpgradeInsecureRequests: 1
      }
    }, function(err, res){
      if(err){
        console.log("initial retrieval failed for case", caseNum);
        return callback(null, {
          caseNum: caseNum,
          type: "FAILED"
        });
      }

      return utils.extractInfo(res.body, function(err, res){
        if(err){
          debug("extracting info failed for case", caseNum);
          // salvage results
          return callback(null, {
            caseNum: caseNum,
            type: "FAILED"
          });
        }
        return callback(null, _.extend({}, res, {
          caseNum: caseNum
        }));
      });
    });
  }
};

function main() {
  var params = _.times(argv.t, function(index){
    return argv.p + utils.pad(_.add(parseInt(argv.n), index), Const.caseNumLength);
  })

  async.mapLimit(params, argv.l, utils.retrieveCaseStatus, function(err, res){
    if(err){
      console.log(err);
    }

    // lets collect some stats
    var bioNum = _.filter(res, function(item){
      return item.type == "BIO";
    }).length;
    var receiptNum = _.filter(res, function(item){
      return item.type == "NOTICE";
    }).length;
    var approvedNum = _.filter(res, function(item){
      return item.type == "APPROVED";
    }).length;
    var unknown = _.filter(res, function(item){
      return item.type == "UNKNOWN";
    }).length;
    var failed = res.length - bioNum - receiptNum - approvedNum - unknown;
    console.log("bio:", bioNum);
    console.log("receipt:", receiptNum);
    console.log("approved:", approvedNum);
    console.log("unknown:", unknown);
    console.log("failed:", failed);
  });
}

main();
