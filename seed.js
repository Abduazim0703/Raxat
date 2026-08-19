const db = require('./db');

const items = [
  { id: 'rahat', name: 'Салат «Рахат»', weight: '200 г', kcal: 320, price: 400, category: 'salads',
    description: 'Говядина, картофель, огурцы маринованные, лук анзур, морковь, зелёный горошек, подсолнечное масло, восточные специи.',
    imageUrl: 'https://images.unsplash.com/photo-1608032076073-a0fe38a53c44?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'koroleva', name: 'Королева', weight: '200 г', kcal: 385, price: 330, category: 'salads',
    description: 'Куриное филе, мясо копчёное, яйцо куриное, кукуруза, сыр голландский, майонез.',
    imageUrl: 'https://images.unsplash.com/photo-1690573313202-4493a7d02e9c?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'olivie', name: 'Оливье', weight: '200 г', kcal: 310, price: 250, category: 'salads',
    description: 'Колбаса говяжья, картофель, огурцы маринованные, морковь, зелёный горошек, майонез.',
    imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'nezhny', name: 'Нежный', weight: '200 г', kcal: 425, price: 380, category: 'salads',
    description: 'Куриное филе, грибы жареные, грецкий орех, чипсы, сыр, майонез.',
    imageUrl: 'https://images.unsplash.com/photo-1546793665-c74683f339c1?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'grech', name: 'Греческий', weight: '200 г', kcal: 215, price: 250, category: 'salads',
    description: 'Помидоры, огурцы, перец болгарский, сыр фетакса, оливки, оливковое масло.',
    imageUrl: 'https://images.unsplash.com/photo-1659270157059-06aa84f64532?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'gnezdo', name: 'Гнездо глухаря', weight: '200 г', kcal: 365, price: 350, category: 'salads',
    description: 'Куриное филе, копчёная колбаса, огурцы маринованные, яйцо перепелиное, зелень укропа, картофель жареный.',
    imageUrl: 'https://images.unsplash.com/photo-1580013759032-c96505e24c1f?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'cesar', name: 'Цезарь с курицей', weight: '200 г', kcal: 340, price: 320, category: 'salads',
    description: 'Куриное филе, салат айсберг, сыр пармезан, яйцо перепелиное, соус цезарь.',
    imageUrl: 'https://images.unsplash.com/photo-1746211108786-ca20c8f80ecd?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'japan', name: 'Японский', weight: '200 г', kcal: 265, price: 400, category: 'salads',
    description: 'Говяжье филе, соевый соус, болгарский перец, огурцы, помидоры, лук, кунжут.',
    imageUrl: 'https://images.unsplash.com/photo-1512852939750-1305098529bf?w=500&h=500&fit=crop&auto=format&q=75' },
  { id: 'tea', name: 'Чёрный чай (чайник)', weight: '400 мл', kcal: 0, price: 150, category: 'drinks',
    description: 'Классический чёрный чай, подаётся в чайнике на двоих.', imageUrl: null },
  { id: 'lemonade', name: 'Лимонад домашний', weight: '300 мл', kcal: 120, price: 200, category: 'drinks',
    description: 'Домашний лимонад с мятой.', imageUrl: null },
  { id: 'cola', name: 'Кока-кола 0.33', weight: '330 мл', kcal: 140, price: 120, category: 'drinks',
    description: 'Охлаждённая кока-кола.', imageUrl: null },
];

const upsert = db.prepare(`
  INSERT INTO menu_items (id, name, description, weight, kcal, price, category, is_dish_of_day, active, image_url)
  VALUES (@id, @name, @description, @weight, @kcal, @price, @category, 0, 1, @imageUrl)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, description=excluded.description, weight=excluded.weight,
    kcal=excluded.kcal, price=excluded.price, category=excluded.category, image_url=excluded.image_url
`);

const tx = db.transaction((rows) => { for (const r of rows) upsert.run(r); });
tx(items);

db.prepare(`UPDATE menu_items SET is_dish_of_day = 0`).run();
db.prepare(`UPDATE menu_items SET is_dish_of_day = 1 WHERE id = 'nezhny'`).run();

console.log(`Seeded ${items.length} menu items.`);
