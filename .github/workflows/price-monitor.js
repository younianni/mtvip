// .github/workflows/price-monitor.js
const https = require('https');
const fs = require('fs').promises; // 使用Promise版本的fs
const path = require('path');
const nodemailer = require('nodemailer');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

// 配置信息
const config = {
  apiUrl: 'https://shop.mt2.cn/ajax.php?act=gettool&cid=2&info=1',
  dataDir: path.join(__dirname, '../data'), // 存储数据的目录
  priceHistoryFile: path.join(__dirname, '../data/price-history.json'),
  weeklyReportFile: path.join(__dirname, '../data/weekly-report.json'),
  email: {
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    smtp: {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    }
  },
  cookies: process.env.API_COOKIES || '',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://shop.mt2.cn/'
  }
};

// 确保目录存在
async function ensureDirectoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`目录已创建: ${dirPath}`);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`创建目录失败: ${dirPath}`, error);
      throw error;
    }
    console.log(`目录已存在: ${dirPath}`);
  }
}

// 确保文件存在
async function ensureFileExists(filePath, defaultContent = '{}') {
  try {
    await fs.access(filePath);
    console.log(`文件已存在: ${filePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await ensureDirectoryExists(path.dirname(filePath));
      await fs.writeFile(filePath, defaultContent, 'utf8');
      console.log(`文件已创建: ${filePath}`);
    } else {
      console.error(`检查文件失败: ${filePath}`, error);
      throw error;
    }
  }
}

// 初始化数据目录和文件
async function initData() {
  await ensureDirectoryExists(config.dataDir);
  await ensureFileExists(config.priceHistoryFile);
  await ensureFileExists(config.weeklyReportFile);
  await ensureDirectoryExists(path.join(__dirname, '../docs'));
}

// 主函数
async function main() {
  try {
    await initData();
    
    // 获取当前日期
    const today = dayjs().format('YYYY-MM-DD');
    
    // 发送请求获取价格数据
    const priceData = await fetchPriceData();
    console.log('获取到价格数据:', priceData);
    
    // 读取历史价格记录
    const history = await readPriceHistory();
    
    // 检查价格变动并发送通知
    const priceChanges = checkPriceChanges(priceData, history);
    if (priceChanges.length > 0) {
      await sendPriceChangeEmail(priceChanges);
      console.log('已发送价格变动通知邮件');
    } else {
      console.log('价格未变动，无需通知');
    }
    
    // 更新价格历史记录
    await updatePriceHistory(today, priceData, history);
    
    // 如果是周一，生成并发送周报
    if (dayjs().day() === 1) { // 1表示周一
      await generateAndSendWeeklyReport(history);
    }
    
    // 更新GitHub Pages数据
    await updateGitHubPagesData(history);
    
  } catch (error) {
    console.error('价格监控任务执行失败:', error);
    process.exit(1);
  }
}

// 发送请求获取价格数据
async function fetchPriceData() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'shop.mt2.cn',
      path: '/ajax.php?act=gettool&cid=2&info=1',
      method: 'GET',
      headers: {
        ...config.headers,
        'Cookie': config.cookies
      }
    };
    
    const req = https.request(options, (response) => {
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          if (parsedData.code === 0 && parsedData.data) {
            // 提取价格信息
            const prices = parsedData.data.reduce((result, item) => {
              result[item.name] = {
                price: parseFloat(item.price),
                timestamp: new Date().toISOString()
              };
              return result;
            }, {});
            resolve(prices);
          } else {
            reject(new Error('API响应错误: ' + (parsedData.msg || '未知错误，状态码:' + response.status)));
          }
        } catch (error) {
          reject(new Error('解析响应数据失败: ' + error.message + ', 原始数据: ' + data));
        }
      });
      
      response.on('error', (error) => {
        reject(error);
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.end();
  });
}

// 读取价格历史记录
async function readPriceHistory() {
  try {
    await ensureFileExists(config.priceHistoryFile);
    const content = await fs.readFile(config.priceHistoryFile, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('读取历史价格记录失败:', error);
    return {};
  }
}

// 检查价格变动
function checkPriceChanges(currentPrices, history) {
  const changes = [];
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  
  for (const [name, currentPrice] of Object.entries(currentPrices)) {
    // 获取昨天的价格
    const historicalPrice = history[yesterday]?.[name]?.price;
    if (historicalPrice !== undefined && currentPrice.price !== historicalPrice) {
      console.log(`价格变动: ${name} - 旧价格: ${historicalPrice}, 新价格: ${currentPrice.price}`);
      changes.push({
        name,
        oldPrice: historicalPrice,
        newPrice: currentPrice.price,
        changeTime: new Date().toLocaleString()
      });
    }
  }
  
  return changes;
}

// 更新价格历史记录
async function updatePriceHistory(date, currentPrices, history) {
  history[date] = currentPrices;
  
  await ensureDirectoryExists(path.dirname(config.priceHistoryFile));
  await fs.writeFile(
    config.priceHistoryFile,
    JSON.stringify(history, null, 2),
    'utf8'
  );
}

// 发送价格变动通知邮件
async function sendPriceChangeEmail(changes) {
  const transporter = nodemailer.createTransport(config.email.smtp);
  
  // 构建邮件内容
  let priceChangesHtml = '';
  changes.forEach(change => {
    priceChangesHtml += `
      <p>${change.name} 价格变动:</p>
      <p>旧价格: ${change.oldPrice}</p>
      <p>新价格: ${change.newPrice}</p>
      <p>变动时间: ${change.changeTime}</p>
      <hr>
    `;
  });
  
  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject: 'MT卡密价格变动通知',
    html: `
      <h3>MT卡密价格变动通知</h3>
      <p>以下商品价格发生了变动:</p>
      ${priceChangesHtml}
      <p>当前时间: ${new Date().toLocaleString()}</p>
    `
  };
  
  await transporter.sendMail(mailOptions);
}

// 生成并发送周报
async function generateAndSendWeeklyReport(history) {
  const today = dayjs();
  const weekAgo = today.subtract(1, 'week');
  
  // 收集本周的数据
  const weeklyData = {};
  const allProducts = new Set();
  
  // 按日期遍历
  for (let d = weekAgo; d.isBefore(today); d = d.add(1, 'day')) {
    const dateStr = d.format('YYYY-MM-DD');
    if (history[dateStr]) {
      for (const [product, info] of Object.entries(history[dateStr])) {
        allProducts.add(product);
        if (!weeklyData[product]) weeklyData[product] = {};
        weeklyData[product][dateStr] = info.price;
      }
    }
  }
  
  // 生成周报HTML
  let weeklyReportHtml = '<h3>MT卡密价格周报</h3>';
  
  allProducts.forEach(product => {
    const productData = weeklyData[product];
    if (Object.keys(productData).length > 0) {
      weeklyReportHtml += `<h4>${product}</h4>`;
      weeklyReportHtml += '<table border="1" cellspacing="0" cellpadding="5">';
      weeklyReportHtml += '<tr><th>日期</th><th>价格</th></tr>';
      
      // 按日期排序
      const sortedDates = Object.keys(productData).sort();
      sortedDates.forEach(date => {
        weeklyReportHtml += `<tr><td>${date}</td><td>${productData[date]}</td></tr>`;
      });
      
      // 计算价格变化
      const firstPrice = productData[sortedDates[0]];
      const lastPrice = productData[sortedDates[sortedDates.length - 1]];
      const change = lastPrice - firstPrice;
      const changePercent = ((change / firstPrice) * 100).toFixed(2);
      
      weeklyReportHtml += `<tr><td>价格变化</td><td>${change >= 0 ? '↑' : '↓'} ${Math.abs(change)} (${changePercent}%)</td></tr>`;
      weeklyReportHtml += '</table><br>';
    }
  });
  
  weeklyReportHtml += `<p>报告周期: ${weekAgo.format('YYYY-MM-DD')} 至 ${today.subtract(1, 'day').format('YYYY-MM-DD')}</p>`;
  weeklyReportHtml += `<p>生成时间: ${new Date().toLocaleString()}</p>`;
  
  // 发送周报邮件
  const transporter = nodemailer.createTransport(config.email.smtp);
  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject: 'MT卡密每周价格报告',
    html: weeklyReportHtml
  };
  
  await transporter.sendMail(mailOptions);
  console.log('已发送周价格报告邮件');
  
  // 保存周报数据
  const reportData = {
    generatedAt: new Date().toISOString(),
    periodStart: weekAgo.format('YYYY-MM-DD'),
    periodEnd: today.subtract(1, 'day').format('YYYY-MM-DD'),
    data: weeklyData
  };
  
  await ensureDirectoryExists(path.dirname(config.weeklyReportFile));
  await fs.writeFile(
    config.weeklyReportFile,
    JSON.stringify(reportData, null, 2),
    'utf8'
  );
}

// 更新GitHub Pages数据
async function updateGitHubPagesData(history) {
  try {
    // 提取最新价格
    const latestDate = Object.keys(history).sort().reverse()[0];
    const latestPrices = latestDate ? history[latestDate] : {};
    
    // 提取所有产品名称
    const products = [...new Set(
      Object.values(history)
        .flatMap(dateData => Object.keys(dateData))
    )];
    
    // 为每个产品准备价格历史
    const productHistories = {};
    products.forEach(product => {
      productHistories[product] = Object.entries(history)
        .filter(([date, data]) => data[product])
        .map(([date, data]) => ({
          date,
          price: data[product].price
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    });
    
    // 构建要保存的数据
    const pageData = {
      lastUpdated: new Date().toISOString(),
      latestPrices,
      productHistories
    };
    
    // 创建docs目录（如果不存在）
    const docsDir = path.join(__dirname, '../docs');
    await ensureDirectoryExists(docsDir);
    
    // 写入GitHub Pages目录
    const filePath = path.join(docsDir, 'price-data.json');
    await fs.writeFile(filePath, JSON.stringify(pageData, null, 2), 'utf8');
    
    console.log('已更新GitHub Pages数据:', filePath);
    
    // 验证文件是否存在
    try {
      await fs.access(filePath);
      console.log('验证: 文件存在:', filePath);
    } catch (error) {
      console.error('验证失败: 文件不存在:', filePath);
      throw error;
    }
  } catch (error) {
    console.error('更新GitHub Pages数据失败:', error);
    throw error;
  }
}

// 执行主函数
main();
