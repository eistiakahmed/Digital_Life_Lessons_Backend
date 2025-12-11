const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_uri;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get('/', (req, res) => {
  res.send('Digital Life Lessons server is running');
});

async function run() {
  try {
    await client.connect();

    const db = client.db('DigitalLifeLessons');
    const lessonCollections = db.collection('lessonCollection');
    const userCollection = db.collection('userCollection');

    //==========================User======================================//

    app.get('/users', async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.post('/user', async (req, res) => {
      const user = req.body;
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: 'user exists' });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch('/user/premium/:email', async (req, res) => {
      const { email } = req.params;
      const { isPremium } = req.body;

      try {
        const result = await userCollection.updateOne(
          { email },
          { $set: { isPremium: isPremium } }
        );

        if (result.modifiedCount > 0) {
          res.send({ message: 'User premium status updated successfully' });
        } else {
          res.send({ message: 'No user updated' });
        }
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server error' });
      }
    });

    //==========================Lessons========================================//

    // Get all lessons or filter by author email
    app.get('/lessons', async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.authorEmail = email;
      }

      const result = await lessonCollections.find().toArray();
      res.send(result);
    });

    // Create lesson
    app.post('/lessons', async (req, res) => {
      const lesson = req.body;
      const result = await lessonCollections.insertOne(lesson);
      res.send(result);
    });

    // Update lesson by ID
    app.put('/lessons/:id', async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: updateData };

      const result = await lessonCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Delete lesson by ID
    app.delete('/lessons/:id', async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };

      const result = await lessonCollections.deleteOne(query);
      res.send(result);
    });

    //==========================Payment=============================//

    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Life Lessons Premium Membership',
              },
              unit_amount: 150000,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.authorEmail,
        mode: 'payment',
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment_success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment_cancelled`,
      });

      console.log(session);
      res.send({ url: session.url });
    });

    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Digital Life Lessons is running port: ${port}`);
});
