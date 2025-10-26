其实我们还可以替换页面中的请求方法，让页面用我们的方法去发请求，那我们拿请求的结果就如探囊取物，这是目前最理想的方式了。以XMLHttpRequest为例，可以这么写。
// inject.js
(function (xhr) {
  if (XMLHttpRequest.prototype.sayMyName) return;
  console.log("%c>>>>> replace XMLHttpRequest", "color:yellow;background:red");
  var XHR = XMLHttpRequest.prototype;
  XHR.sayMyName = "aqinogbei";
  var open = XHR.open;
  var send = XHR.send;
  XHR.open = function (method, url) {
    this._method = method; // 记录method和url
    this._url = url;
    return open.apply(this, arguments);
  };
  XHR.send = function () {
    if (this._url.includes("target_path")) {
        this.addEventListener("load", function (xhr) {
          console.log('xhr'， xhr)
        });
    }
    return send.apply(this, arguments);
  };
})(XMLHttpRequest);
这样，我们就可以狸猫换太子，把页面中的请求方法换成自己的了。
但是现在又遇到一个问题，我们该如何将这段代码注入到页面中呢？这个方法还是较多的。
1. content_scripts注入 (推荐👍)
我们知道content_scripts是和目标页面运行在一起的，所以把上面的代码直接写在content.js中就行了。但是，如果你就这么做了，你就会发现：
>>>>> replace XMLHttpRequest这条log也能打出来，但是我们期待的console.log('xhr'， xhr)却没有执行，替换没生效。
那这是咋回事呢？这就不得不提出这样一个问题：content_scripts的运行环境和目标页面到底是不是在一块的？
chrome的开发者文档里是这么写的：
Content scripts are files that run in the context of web pages. Using the standard Document Object Model (DOM), they are able to read details of the web pages the browser visits, make changes to them, and pass information to their parent extension.
这里面有一句关键的，run in the context of web pages，随后还有更关键的。
Work in isolated worlds
Content scripts live in an isolated world, allowing a content script to make changes to its JavaScript environment without conflicting with the page or other extensions' content scripts.
Key term:  An isolated world is a private execution environment that isn't accessible to the page or other extensions. A practical consequence of this isolation is that JavaScript variables in an extension's content scripts are not visible to the host page or other extensions' content scripts. The concept was originally introduced with the initial launch of Chrome, providing isolation for browser tabs.
简单来说就是，content_scripts和目标页面是运行在一块的，DOM这些是共用一套，但是Javascript执行环境是隔离的。这也就解释了为啥上面替换没生效，因为上面的脚本换掉的是自己执行环境中的XMLHttpRequest，而不是目标页面的。
那么，能不能让注入代码的执行环境和目标页面的执行环境不隔离呢？
这是个好问题。答案是可以的，chrome插件提供了一个叫world的配置项，它有两个值：ISOLATED(默认值)和MAIN。前者指明content_scripts是在隔离的环境中执行的，后者指明content_scripts和目标页面在一个环境中执行。
在一个环境执行，也就意味着，注入的脚本可以获取、修改目标页面的全局变量，替换请求方法更是不在话下。(对于爬虫开发者来说，这个配置意味着很多，是个值钱的知识点)。
所以，我们大致如下这么配置就可以实现替换。
// manifest.json
{
 "content_scripts": [
        {
            "matches": ["target_page_url"],// 改为自己的目标网站url
            "js": ["inject.js"], // 要注入的脚本
            "world": "MAIN", // 注入代码和目标页面在一个环境中执行
            "run_at": "document_start" // 注入脚本的时机
        }
    ]
}
到目前为止，上面这段核心manifest.json配置，加上inject.js，不需要额外的background.js，甚至无需permissions配置即可实现自动在目标页面注入我们的代码，获取请求结果，甚为简单、优雅。
但是需要注意的，这里有个bug。
虽然说chrome文档里写的是
Content scripts可以直接使用这些API
● dom
● i18n
● storage
● runtime.connect()
● runtime.getManifest()
● runtime.getURL()
● runtime.id
● runtime.onConnect
● runtime.onMessage
● runtime.sendMessage()
但是，如果你在mainfest.json中将content_scripts内的js配置为了"world": "MAIN"，那么，上面那些API就无法使用了，这点是文档里没有提到的。
(细想下，如果这样可行的话，那content_scripts简直太强了，既和页面在一个执行环境，能够获取页面的变量、DOM等，又拥有Chrome插件的的一些API，屌爆简直)
解决办法有两种：
1. 在mainfest.json中将"world"改为"ISOLATED"，或删除 （默认"ISOLATED"）
2. 在background.js中动态注入mainfest.json
chrome.scripting.registerContentScripts([
    {
         id: 'script-id',
         js: [mainWorldLoader],
         persistAcrossSessions: false,
         world: 'MAIN'
   }
])
参考链接
● CRXJS doesn't work with content script in "MAIN" world #695
● Strategies for injecting code with registerContentScripts and CRXJS #643
当然，上面那种情况注入是主动，适合一打开页面就注入脚本的场景，如果场景不一样，还有别的注入方式。
2. 从background中注入
在background里，我们可以使用chrome.scripting.executeScript方法向页面注入代码，相关配置参数较多，可以自行查看，比较关键的是，它支持world
配置，值的情况同上面的一样。
chrome.action.onClicked.addListener(function(tab) {
  chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ["inject.js"],
      world: 'MAIN'
  });
});
它适合被动触发的情况，比如某个页面给background.js一个消息，然后background里执行chrome.scripting.executeScript方法，发起注入操作。这里需要注意的是，调用chrome.scripting.executeScript方法，需要申请scripting权限。
3. 其他注入方式
在content_scripts里你还可以通过向页面中插入script标签的形式实现动态注入，这里不展开描述。