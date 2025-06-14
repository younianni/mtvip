// .github/workflows/price-monitor.js
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

// 配置信息
const config = {
  apiUrl: 'https://shop.mt2.cn/ajax.php?act=gettool&cid=2&info=1',
  dataDir: path.join(__dirname, '../../data'),
  priceHistoryFile: path.join(__dirname, '../../data/price-history.json'),
  weeklyReportFile: path.join(__dirname, '../../data/weekly-report.json'),
  githubPagesDir: path.join(__dirname, '../../docs'),
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

// 安全写入文件（带验证）
async function safeWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  
  try {
    // 写入临时文件
    await fs.writeFile(tempPath, content, 'utf8');
    
    // 验证临时文件内容
    const writtenContent = await fs.readFile(tempPath, 'utf8');
    if (writtenContent !== content) {
      throw new Error('写入内容与预期不符');
    }
    
    // 原子性替换目标文件
    await fs.rename(tempPath, filePath);
    console.log(`文件写入成功: ${filePath}`);
  } catch (error) {
    // 发生错误时删除临时文件
    try { await fs.unlink(tempPath); } catch {}
    console.error(`文件写入失败: ${filePath}`, error);
    throw error;
  }
}

// 获取最新价格
function getLatestPrices(history) {
  const allDates = Object.keys(history).sort();
  if (allDates.length === 0) return {};
  
  const latestDate = allDates[allDates.length - 1];
  return history[latestDate] || {};
}

// 初始化数据目录和文件
async function initData() {
  console.log('开始初始化数据目录...');
  await ensureDirectoryExists(config.dataDir);
  await ensureFileExists(config.priceHistoryFile);
  await ensureFileExists(config.weeklyReportFile);
  await ensureDirectoryExists(config.githubPagesDir);
  console.log('数据目录初始化完成');
}

// 主函数
async function main() {
  try {
    console.log('===== 价格监控任务开始 =====');
    await initData();
    
    // 获取当前日期
    const today = dayjs().format('YYYY-MM-DD');
    console.log(`当前日期: ${today}`);
    
    // 发送请求获取价格数据
    const priceData = await fetchPriceData();
    console.log('获取到价格数据:', JSON.stringify(priceData, null, 2));
    
    // 读取历史价格记录
    const history = await readPriceHistory();
    console.log(`已读取历史价格记录，包含 ${Object.keys(history).length} 天数据`);
    
    // 检查价格变动并发送通知
    const priceChanges = checkPriceChanges(priceData, history, today);
    if (priceChanges.length > 0) {
      console.log(`检测到 ${priceChanges.length} 个价格变动`);
      await sendPriceChangeEmail(priceChanges);
      console.log('已发送价格变动通知邮件');
    } else {
      console.log('价格未变动，无需通知');
    }
    
    // 更新价格历史记录
    await updatePriceHistory(today, priceData, history);
    console.log('价格历史记录已更新');
    
    // 如果是周一，生成并发送周报
    if (dayjs().day() === 7) { // 1表示周一
      console.log('今天是周一，生成周报告...');
      await generateAndSendWeeklyReport(history);
      console.log('周报告已生成并发送');
    } else {
      console.log('今天不是周一，跳过周报告生成');
    }
    
    // 更新GitHub Pages数据
    await updateGitHubPagesData(history);
    console.log('GitHub Pages数据已更新');
    
    console.log('===== 价格监控任务完成 =====');
  } catch (error) {
    console.error('价格监控任务执行失败:', error);
    process.exit(1);
  }
}

// 发送请求获取价格数据
async function fetchPriceData() {
  console.log('开始请求API数据...');
  
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
      console.log(`API响应状态码: ${response.statusCode}`);
      
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        console.log(`API响应长度: ${data.length} 字节`);
        
        try {
          const parsedData = JSON.parse(data);
          console.log('API响应解析成功');
          
          if (parsedData.code === 0 && parsedData.data) {
            // 提取价格信息
            const prices = parsedData.data.reduce((result, item) => {
              result[item.name] = {
                price: parseFloat(item.price),
                timestamp: new Date().toISOString()
              };
              return result;
            }, {});
            
            console.log(`成功提取 ${Object.keys(prices).length} 个产品价格`);
            resolve(prices);
          } else {
            reject(new Error('API响应错误: ' + (parsedData.msg || '未知错误，状态码:' + response.statusCode)));
          }
        } catch (error) {
          // 打印原始响应数据以便调试
          console.error('原始API响应:', data.substring(0, 500) + (data.length > 500 ? '...' : ''));
          reject(new Error('解析响应数据失败: ' + error.message));
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
    const history = JSON.parse(content);
    return history;
  } catch (error) {
    console.error('读取历史价格记录失败:', error);
    return {};
  }
}

// 检查价格变动
function checkPriceChanges(currentPrices, history, today) {
  const changes = [];
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  
  console.log(`检查与 ${yesterday} 的价格差异`);
  
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
  // 确保当天数据存在
  if (!history[date]) {
    history[date] = {};
  }
  
  // 更新当天的价格数据
  for (const [name, priceInfo] of Object.entries(currentPrices)) {
    history[date][name] = priceInfo;
  }
  
  await safeWriteFile(
    config.priceHistoryFile,
    JSON.stringify(history, null, 2)
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
      <p><a href="https://younianni.github.io/mtvip/">https://younianni.github.io/mtvip/</a></p>
      <p>以下商品价格发生了变动:</p>
      ${priceChangesHtml}
      <p>当前时间: ${new Date().toLocaleString()}</p>
    `
  };
  
  console.log(`准备发送价格变动邮件，包含 ${changes.length} 个变动`);
  await transporter.sendMail(mailOptions);
  console.log('价格变动邮件已发送');
}

// 生成并发送周报
async function generateAndSendWeeklyReport(history) {
  const today = dayjs();
  const weekAgo = today.subtract(1, 'week');
  console.log(`生成周报告，周期: ${weekAgo.format('YYYY-MM-DD')} 至 ${today.format('YYYY-MM-DD')}`);
  
  // 收集本周的数据
  const weeklyData = {};
  const allProducts = new Set();
  
  // 按日期遍历
  for (let d = weekAgo; d.isBefore(today); d = d.add(1, 'day')) {
    const dateStr = d.format('YYYY-MM-DD');
    if (history[dateStr]) {
      // 取当天最后一次更新的价格
      const dateData = history[dateStr];
      for (const [product, info] of Object.entries(dateData)) {
        allProducts.add(product);
        if (!weeklyData[product]) weeklyData[product] = {};
        weeklyData[product][dateStr] = info.price;
      }
    }
  }
  
  console.log(`周报告包含 ${allProducts.size} 个产品的数据`);
  
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
  
  console.log('准备发送周报告邮件');
  await transporter.sendMail(mailOptions);
  console.log('周报告邮件已发送');
  
  // 保存周报数据
  const reportData = {
    generatedAt: new Date().toISOString(),
    periodStart: weekAgo.format('YYYY-MM-DD'),
    periodEnd: today.subtract(1, 'day').format('YYYY-MM-DD'),
    data: weeklyData
  };
  
  await safeWriteFile(
    config.weeklyReportFile,
    JSON.stringify(reportData, null, 2)
  );
}

// 更新GitHub Pages数据
async function updateGitHubPagesData(history) {
  try {
    console.log('开始更新GitHub Pages数据...');
    
    // 提取所有日期并排序
    const allDates = Object.keys(history).sort();
    
    // 提取所有产品名称
    const products = [...new Set(
      Object.values(history)
        .flatMap(dateData => Object.keys(dateData))
    )];
    
    console.log(`提取了 ${products.length} 个产品的历史数据`);
    
    // 为每个产品准备价格历史，包含每天的最后一次价格
    const productHistories = {};
    products.forEach(product => {
      productHistories[product] = allDates.map(date => {
        const priceInfo = history[date]?.[product];
        return {
          date,
          price: priceInfo?.price || null,
          timestamp: priceInfo?.timestamp
        };
      }).filter(item => item.price !== null);
    });
    
    // 构建要保存的数据
    const pageData = {
      lastUpdated: new Date().toISOString(),
      latestPrices: getLatestPrices(history),
      productHistories,
      allDates
    };
    
    // 写入GitHub Pages目录
    const filePath = path.join(config.githubPagesDir, 'price-data.json');
    await safeWriteFile(filePath, JSON.stringify(pageData, null, 2));
    
    console.log('GitHub Pages数据更新完成');
    
  } catch (error) {
    console.error('更新GitHub Pages数据失败:', error);
    throw error;
  }
}

// 执行主函数
main();
